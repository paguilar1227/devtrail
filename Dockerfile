# ---------- Frontend build stage ----------
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Backend build stage ----------
FROM node:20-alpine AS backend-builder

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src/ ./src/
RUN npm run build

# ---------- Runtime ----------
FROM node:20-alpine AS runner

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /frontend/dist ./frontend/dist
COPY migrations/ ./migrations/

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
