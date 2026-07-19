# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT:
#
#   docker build -f apps/integration-gateway/Dockerfile -t integration-gateway:latest .
#
# Long-lived, low-privilege service (docs/security.md): outbound network to
# agent-orchestrator and the GitHub API only, no k8s API access (unlike
# apps/agent-orchestrator, this app never creates ToolRun/AgentRun CRs
# itself -- it relays into the orchestrator's existing /invoke API).

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/github-app-auth/package.json packages/github-app-auth/package.json
COPY apps/integration-gateway/package.json apps/integration-gateway/package.json
RUN npm ci

COPY packages/github-app-auth packages/github-app-auth
COPY apps/integration-gateway/tsconfig.json apps/integration-gateway/tsconfig.json
COPY apps/integration-gateway/src         apps/integration-gateway/src

RUN npm run build --workspace=@controller-agent/github-app-auth \
  && npm run build --workspace=integration-gateway \
  && npm prune --omit=dev \
  # Materialize the workspace package as a real directory (not a symlink) so
  # it survives the copy into the runtime stage.
  && rm -rf node_modules/@controller-agent/github-app-auth \
  && mkdir -p node_modules/@controller-agent/github-app-auth \
  && cp -r packages/github-app-auth/dist        node_modules/@controller-agent/github-app-auth/dist \
  && cp packages/github-app-auth/package.json   node_modules/@controller-agent/github-app-auth/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules                       ./node_modules
COPY --from=build /repo/apps/integration-gateway/dist       ./dist
COPY --from=build /repo/apps/integration-gateway/package.json ./package.json

# Matches the hardened run contract in docs/security.md: non-root, read-only
# rootfs (no writable state needed -- this app holds nothing on disk).
USER node

ENTRYPOINT ["node", "dist/index.js"]
