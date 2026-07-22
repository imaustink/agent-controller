# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/kubectl-readonly/Dockerfile -t kubectl-readonly:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/kubectl-readonly/package.json tools/kubectl-readonly/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/kubectl-readonly/tsconfig.json tools/kubectl-readonly/tsconfig.json
COPY tools/kubectl-readonly/src tools/kubectl-readonly/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=kubectl-readonly \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r packages/messaging/dist node_modules/@controller-agent/messaging/dist \
  && cp packages/messaging/package.json node_modules/@controller-agent/messaging/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime

# Pinned kubectl binary, verified against the official checksum published
# alongside the same release (fetched at build time rather than hardcoded,
# so the check stays correct if this ARG is bumped without also updating a
# stale hash). Bump KUBECTL_VERSION to upgrade.
ARG KUBECTL_VERSION=v1.31.2
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" -o /tmp/kubectl.sha256 \
  && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod a+rx /usr/local/bin/kubectl \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /tmp/kubectl.sha256

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/kubectl-readonly/dist ./dist
COPY --from=build /repo/tools/kubectl-readonly/package.json ./package.json

USER node

ENTRYPOINT ["node", "dist/index.js"]
