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
#
# node:22, not :20 (since docs/adr/0027's per-user Claude OAuth setup-token
# flow was added): @anthropic-ai/claude-code requires Node >=22. `node-pty`
# (that same flow's PTY dependency) is a native addon -- python3/make/g++ are
# installed in the build stage only long enough to compile it; the resulting
# binary is copied into the runtime stage as part of node_modules, which
# never needs its own toolchain since it doesn't rebuild anything.

############################
# Build stage
############################
FROM node:22-bookworm-slim AS build
WORKDIR /repo

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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
FROM node:22-bookworm-slim AS runtime

ARG CLAUDE_CODE_VERSION=2.1.218

# Claude Code CLI, pinned -- only needed when GATEWAY_CLAUDE_AUTH_ENABLED=true
# (docs/adr/0027); harmless (a few MB, unused) otherwise. Same pin/version
# caveat as claude-code-swe-agent's Dockerfile -- `claude setup-token`'s TUI
# output isn't a stable API across versions.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules                       ./node_modules
COPY --from=build /repo/apps/integration-gateway/dist       ./dist
COPY --from=build /repo/apps/integration-gateway/package.json ./package.json

# Matches the hardened run contract in docs/security.md: non-root, read-only
# rootfs -- the claude-auth flow's own state (its PTY child's HOME) must
# therefore go under /tmp; this app otherwise holds nothing else on disk.
USER node
ENV HOME=/tmp

ENTRYPOINT ["node", "dist/index.js"]
