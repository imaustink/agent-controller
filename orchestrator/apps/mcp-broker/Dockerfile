# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (the lockfile is the workspace's):
#
#   docker build -f orchestrator/apps/mcp-broker/Dockerfile -t mcp-broker:latest .
#
# This is a SEPARATE image from agent-orchestrator on purpose (ADR 0045 §3).
# The broker is the only process that links an MCP client and holds MCP
# sessions; the orchestrator holds the deterministic agent loop and cluster
# RBAC. Keeping them in one pod would let a malformed or hostile MCP server
# reach the loop's process, secrets or identity — the containment this split
# exists to provide.

############################
# Build stage
############################
FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY orchestrator/apps/mcp-broker/package.json orchestrator/apps/mcp-broker/package.json
RUN npm ci --workspace=mcp-broker --include-workspace-root

COPY orchestrator/apps/mcp-broker/tsconfig.json orchestrator/apps/mcp-broker/tsconfig.json
COPY orchestrator/apps/mcp-broker/src orchestrator/apps/mcp-broker/src

RUN npm run build --workspace=mcp-broker && npm prune --omit=dev

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
# transitive is then removed by `npm prune --omit=dev` — leaving the image with
# neither. The @modelcontextprotocol/sdk tree is the shape most likely to land
# here, so the broker copies the workspace's own modules in if the directory
# exists.
#
# Optional, via the trailing `.`-safe glob: most builds hoist everything and
# leave no such directory.
COPY --from=build /repo/orchestrator/apps/mcp-broker/node_module[s] ./node_modules_ws
RUN if [ -d ./node_modules_ws ]; then cp -R ./node_modules_ws/. ./node_modules/ && rm -rf ./node_modules_ws; fi
COPY --from=build /repo/orchestrator/apps/mcp-broker/dist ./dist
COPY --from=build /repo/orchestrator/apps/mcp-broker/package.json ./package.json

RUN useradd --system --uid 10001 --create-home broker
USER broker

ENTRYPOINT ["node", "dist/index.js"]
