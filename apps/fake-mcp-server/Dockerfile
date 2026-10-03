# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (the lockfile is the workspace's):
#
#   docker build -f apps/fake-mcp-server/Dockerfile -t fake-mcp-server:latest .
#
# E2E ONLY. A minimal, deterministic MCP server over streamable-http that stands
# in for a third-party MCP server (docs/adr/0045). It exposes a FIXED tool set
# (echo, whoami, boom) so cluster e2e tests exercise the real mcp-broker and
# real engines end to end without a real external server; see
# apps/fake-mcp-server/src/index.ts. It is the "thing we don't own" stub: it
# enforces no auth and only reflects the inbound Bearer token via whoami.

############################
# Build stage
############################
FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY apps/fake-mcp-server/package.json apps/fake-mcp-server/package.json
RUN npm ci --workspace=fake-mcp-server --include-workspace-root

COPY apps/fake-mcp-server/tsconfig.json apps/fake-mcp-server/tsconfig.json
COPY apps/fake-mcp-server/src apps/fake-mcp-server/src

RUN npm run build --workspace=fake-mcp-server && npm prune --omit=dev

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
# here, so this fixture copies the workspace's own modules in if the directory
# exists.
#
# Optional, via the trailing `.`-safe glob: most builds hoist everything and
# leave no such directory.
COPY --from=build /repo/apps/fake-mcp-server/node_module[s] ./node_modules_ws
RUN if [ -d ./node_modules_ws ]; then cp -R ./node_modules_ws/. ./node_modules/ && rm -rf ./node_modules_ws; fi
COPY --from=build /repo/apps/fake-mcp-server/dist ./dist
COPY --from=build /repo/apps/fake-mcp-server/package.json ./package.json

RUN useradd --system --uid 10001 --create-home fake
USER fake

ENTRYPOINT ["node", "dist/index.js"]
