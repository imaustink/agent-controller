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
FROM node:20-bookworm-slim AS build
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
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/connection-broker/dist ./dist
COPY --from=build /repo/apps/connection-broker/package.json ./package.json

RUN useradd --system --uid 10001 --create-home broker
USER broker

ENTRYPOINT ["node", "dist/index.js"]
