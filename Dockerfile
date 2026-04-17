# ---------- Web build stage ----------
FROM node:20-alpine AS web-builder

WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- Backend build stage ----------
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------- Runtime ----------
FROM node:20-alpine AS runner

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=web-builder /web/dist ./web/dist
COPY migrations/ ./migrations/

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
