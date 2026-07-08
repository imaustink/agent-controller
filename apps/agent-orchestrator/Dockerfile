# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @recipe-agent/messaging workspace package):
#
#   docker build -f apps/agent-orchestrator/Dockerfile -t agent-orchestrator:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Install across the whole workspace so the local @recipe-agent/messaging
# package resolves without hitting the registry.
COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY apps/agent-orchestrator/package.json apps/agent-orchestrator/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY apps/agent-orchestrator/tsconfig.json apps/agent-orchestrator/tsconfig.json
COPY apps/agent-orchestrator/src apps/agent-orchestrator/src

RUN npm run build --workspace=@recipe-agent/messaging \
  && npm run build --workspace=agent-orchestrator \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@recipe-agent/messaging \
  && mkdir -p node_modules/@recipe-agent/messaging \
  && cp -r packages/messaging/dist node_modules/@recipe-agent/messaging/dist \
  && cp packages/messaging/package.json node_modules/@recipe-agent/messaging/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/agent-orchestrator/dist ./dist
COPY --from=build /repo/apps/agent-orchestrator/package.json ./package.json

# NOTE: no per-tool manifest.json COPY lines here anymore (ADR 0009 is
# superseded by ADR 0010) -- the tool catalog is now discovered at runtime
# from `Tool` custom resources (see src/registry/crd-tool-registry.ts)
# rather than baked into this image at build time. Registering a new tool
# is now "apply a Tool CR", not "add a COPY line + rebuild".

RUN useradd --system --uid 10001 --create-home orchestrator
USER orchestrator

ENTRYPOINT ["node", "dist/index.js"]
