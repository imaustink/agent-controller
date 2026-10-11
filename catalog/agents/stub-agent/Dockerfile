# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT:
#
#   docker build -f catalog/agents/stub-agent/Dockerfile -t stub-agent:latest .
#
# E2E ONLY. This agent speaks the real NATS agent protocol
# (@controller-agent/agent-runtime) and returns a canned reply -- no model call,
# no credential of its own, no network egress beyond NATS. It exists so the
# happy-path e2e spec can assert the whole webhook -> triage -> AgentRun ->
# reply -> issue-comment chain hermetically; see catalog/agents/stub-agent/src/index.ts.
#
# Deliberately unprivileged and toolchain-free, unlike claude-code-swe-agent:
# no git, no gh, no Go, no Claude Code CLI. If this image ever needs one of
# those, the stub has stopped being a stub.

############################
# Build stage
############################
FROM node:22-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY framework/messaging/package.json     framework/messaging/package.json
COPY framework/agent-runtime/package.json framework/agent-runtime/package.json
COPY catalog/agents/stub-agent/package.json        catalog/agents/stub-agent/package.json
RUN npm ci

COPY framework/messaging      framework/messaging
COPY framework/agent-runtime  framework/agent-runtime
COPY catalog/agents/stub-agent/tsconfig.json catalog/agents/stub-agent/tsconfig.json
COPY catalog/agents/stub-agent/src           catalog/agents/stub-agent/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=@controller-agent/agent-runtime \
  && npm run build --workspace=stub-agent \
  && npm prune --omit=dev \
  # Materialize workspace packages as real directories (not symlinks) so they
  # survive the copy into the runtime stage.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r framework/messaging/dist      node_modules/@controller-agent/messaging/dist \
  && cp framework/messaging/package.json node_modules/@controller-agent/messaging/package.json \
  && rm -rf node_modules/@controller-agent/agent-runtime \
  && mkdir -p node_modules/@controller-agent/agent-runtime \
  && cp -r framework/agent-runtime/dist      node_modules/@controller-agent/agent-runtime/dist \
  && cp framework/agent-runtime/package.json node_modules/@controller-agent/agent-runtime/package.json

############################
# Runtime stage
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules              ./node_modules
COPY --from=build /repo/catalog/agents/stub-agent/dist      ./dist
COPY --from=build /repo/catalog/agents/stub-agent/package.json ./package.json

# The core-controller's hardened Job securityContext runs as non-root with a
# read-only root filesystem and an emptyDir at /tmp. The stub writes nothing.
USER node

ENTRYPOINT ["node", "dist/index.js"]
