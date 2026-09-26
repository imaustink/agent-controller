# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (the lockfile is the workspace's):
#
#   docker build -f apps/connection-broker/Dockerfile -t connection-broker:latest .
#
# This is a SEPARATE image from agent-orchestrator on purpose (ADR 0038 §3).
# The broker holds every client's third-party credentials and makes outbound
# calls on their behalf; the orchestrator holds cluster RBAC. Keeping them in
# one pod would mean a compromise of either reached both.

############################
# Build stage
############################
FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY apps/connection-broker/package.json apps/connection-broker/package.json
RUN npm ci --workspace=connection-broker --include-workspace-root

COPY apps/connection-broker/tsconfig.json apps/connection-broker/tsconfig.json
COPY apps/connection-broker/src apps/connection-broker/src

RUN npm run build --workspace=connection-broker && npm prune --omit=dev

############################
# Runtime stage
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
# The workspace's OWN node_modules, when npm could not hoist something.
#
# A dependency whose version conflicts with another workspace's is nested here
# instead of at the root, and a root copy that exists only as somebody's dev
# transitive is then removed by `npm prune --omit=dev` — leaving the image
# with neither. parse5 is exactly that shape, and the broker crashlooped on
# ERR_MODULE_NOT_FOUND with the package plainly present in package.json.
#
# Optional, via the trailing `.`-safe glob: most builds hoist everything and
# leave no such directory.
COPY --from=build /repo/apps/connection-broker/node_module[s] ./node_modules_ws
RUN if [ -d ./node_modules_ws ]; then cp -R ./node_modules_ws/. ./node_modules/ && rm -rf ./node_modules_ws; fi
COPY --from=build /repo/apps/connection-broker/dist ./dist
COPY --from=build /repo/apps/connection-broker/package.json ./package.json

RUN useradd --system --uid 10001 --create-home broker
USER broker

ENTRYPOINT ["node", "dist/index.js"]
