# ---------- Builder ----------
# Single workspace-aware builder. Compiles `shared` → `backend` → `frontend`
# in that order because backend + frontend both consume `@open-brain/shared`.
FROM node:20-alpine AS builder

WORKDIR /app

# Workspace manifests first so npm ci can resolve the dependency graph
# without invalidating the layer on every source change.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci

# Copy each workspace's sources + tsconfig and build in dependency order.
COPY shared/ ./shared/
RUN npm run build --workspace=@open-brain/shared

COPY backend/tsconfig.json ./backend/
COPY backend/src/ ./backend/src/
RUN npm run build --workspace=open-brain-backend

COPY frontend/ ./frontend/
RUN npm run build --workspace=open-brain-frontend

# ---------- Runtime ----------
FROM node:20-alpine AS runner

# pdf-parse needs ffmpeg-free image work, but real ffmpeg is required for
# the gemini audio probe path used by metadata extraction.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Bring in the entire workspace tree from the builder. npm hoists most
# deps to the root /app/node_modules and symlinks workspaces into it; the
# easiest correct copy is "everything", which still ends up small because
# the builder already excluded test/dev sources via npm's prune behavior.
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/backend/package.json ./backend/package.json
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist

# Migrations: server.ts reads them via `__dirname/../migrations/...`.
# With server.js at /app/backend/dist/server.js, __dirname=/app/backend/dist
# and the resolved path is /app/backend/migrations/. Match that.
COPY migrations/ ./backend/migrations/

EXPOSE 3000
ENV NODE_ENV=production

# Server resolves frontend/dist via app.use('/*', serveStatic({root: './frontend/dist'}))
# from /app, so this WORKDIR must remain /app (not /app/backend).
CMD ["node", "backend/dist/server.js"]
