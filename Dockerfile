FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS production_dependencies
RUN npm prune --omit=dev

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=production_dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
