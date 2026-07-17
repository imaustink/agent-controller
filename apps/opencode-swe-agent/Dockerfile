# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT:
#
#   docker build -f apps/opencode-swe-agent/Dockerfile -t opencode-swe-agent:latest .
#
# This is a PRIVILEGED agent (docs/security.md): it needs outbound network to
# GitHub + the Anthropic API, a writable workspace (/tmp emptyDir), a GitHub
# App credential (git/gh operations), and an Anthropic API key (opencode's
# model credential -- the two are independent secrets, unlike the old Copilot
# CLI which used one PAT for both). The agent runtime
# (@controller-agent/agent-runtime) connects to NATS (AGENT_NATS_URL) and
# receives its run id + initial goal via env (AGENT_RUN_ID, AGENT_GOAL) --
# injected by the Go tool-controller into the k8s Job when it reconciles the
# AgentRun CR (Phase 7).

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json   packages/messaging/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY apps/opencode-swe-agent/package.json apps/opencode-swe-agent/package.json
RUN npm ci

COPY packages/messaging   packages/messaging
COPY packages/agent-runtime packages/agent-runtime
COPY apps/opencode-swe-agent/tsconfig.json apps/opencode-swe-agent/tsconfig.json
COPY apps/opencode-swe-agent/src           apps/opencode-swe-agent/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=@controller-agent/agent-runtime \
  && npm run build --workspace=opencode-swe-agent \
  && npm prune --omit=dev \
  # Materialize workspace packages as real directories (not symlinks) so they
  # survive the copy into the runtime stage.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r packages/messaging/dist        node_modules/@controller-agent/messaging/dist \
  && cp packages/messaging/package.json   node_modules/@controller-agent/messaging/package.json \
  && rm -rf node_modules/@controller-agent/agent-runtime \
  && mkdir -p node_modules/@controller-agent/agent-runtime \
  && cp -r packages/agent-runtime/dist    node_modules/@controller-agent/agent-runtime/dist \
  && cp packages/agent-runtime/package.json node_modules/@controller-agent/agent-runtime/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime

ARG GH_VERSION=2.63.2
ARG GO_VERSION=1.24.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip make \
  # GitHub CLI -- installed from the official release tarball for a hermetic build.
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz" \
     | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_${GH_VERSION}_linux_arm64" \
  # Go toolchain -- installed from the official tarball; arch is detected at build time.
  && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" \
     | tar -xz -C /usr/local \
  # Agentic opencode CLI, configured to call Anthropic (Claude Sonnet 5) directly.
  && npm install -g opencode-ai@latest \
  && npm cache clean --force \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/usr/local/go/bin:$PATH"
ENV GOPATH="/tmp/go"

COPY --from=build /repo/node_modules                     ./node_modules
COPY --from=build /repo/apps/opencode-swe-agent/dist      ./dist
COPY --from=build /repo/apps/opencode-swe-agent/package.json ./package.json

# The tool-controller's hardened Job securityContext runs as uid 10001 with a
# read-only root filesystem + emptyDir at /tmp. All writable state (workspace,
# git credentials, NATS connection) goes under /tmp.
USER node

ENTRYPOINT ["node", "dist/index.js"]
