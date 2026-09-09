# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/glyph/Dockerfile -t glyph:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Install across the whole workspace so the local @controller-agent/messaging
# package resolves without hitting the registry.
COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/glyph/package.json tools/glyph/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/glyph/tsconfig.json tools/glyph/tsconfig.json
COPY tools/glyph/src tools/glyph/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=glyph \
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
# No browser/CLI needed — this tool only calls the Glyph REST API over HTTPS.
FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/glyph/dist ./dist
COPY --from=build /repo/tools/glyph/package.json ./package.json

# node:20-bookworm-slim ships an unprivileged 'node' user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
