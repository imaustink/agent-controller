# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f orchestrator/apps/agent-orchestrator/Dockerfile -t agent-orchestrator:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Install across the whole workspace so the local @controller-agent/messaging
# package resolves without hitting the registry.
COPY package.json package-lock.json* ./
COPY framework/messaging/package.json framework/messaging/package.json
COPY orchestrator/apps/agent-orchestrator/package.json orchestrator/apps/agent-orchestrator/package.json
RUN npm ci

COPY framework/messaging framework/messaging
COPY orchestrator/apps/agent-orchestrator/tsconfig.json orchestrator/apps/agent-orchestrator/tsconfig.json
COPY orchestrator/apps/agent-orchestrator/src orchestrator/apps/agent-orchestrator/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=agent-orchestrator \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r framework/messaging/dist node_modules/@controller-agent/messaging/dist \
  && cp framework/messaging/package.json node_modules/@controller-agent/messaging/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/orchestrator/apps/agent-orchestrator/dist ./dist
COPY --from=build /repo/orchestrator/apps/agent-orchestrator/package.json ./package.json

# NOTE: no per-tool manifest.json COPY lines here anymore (ADR 0009 is
# superseded by ADR 0010) -- the tool catalog is now discovered at runtime
# from `Tool` custom resources (see src/registry/crd-tool-registry.ts)
# rather than baked into this image at build time. Registering a new tool
# is now "apply a Tool CR", not "add a COPY line + rebuild".

RUN useradd --system --uid 10001 --create-home orchestrator
USER orchestrator

ENTRYPOINT ["node", "dist/index.js"]
