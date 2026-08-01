# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/web-search/Dockerfile -t web-search:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Install across the whole workspace so the local @controller-agent/messaging
# package resolves without hitting the registry.
COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/web-search/package.json tools/web-search/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/web-search/tsconfig.json tools/web-search/tsconfig.json
COPY tools/web-search/src tools/web-search/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=web-search \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r packages/messaging/dist node_modules/@controller-agent/messaging/dist \
  && cp packages/messaging/package.json node_modules/@controller-agent/messaging/package.json

############################
# Runtime stage
############################
# No Playwright/yt-dlp needed here -- this tool only calls the in-cluster
# SearXNG JSON API.
FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/web-search/dist ./dist
COPY --from=build /repo/tools/web-search/package.json ./package.json

# node:20-bookworm-slim ships an unprivileged 'node' user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
