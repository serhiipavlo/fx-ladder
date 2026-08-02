# Build context is the repo root:
#   docker build -f apps/feed-server/Dockerfile -t fx-feed-server .
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@11.18.0

# Manifests first so the dependency layer caches across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY packages/sim-core/package.json packages/sim-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/feed-server/package.json apps/feed-server/
RUN pnpm install --frozen-lockfile --filter @fx/feed-server...

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/feed-server/ apps/feed-server/
RUN pnpm --filter @fx/feed-server run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/feed-server/dist/server.mjs ./
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
