# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/copilot-swe/Dockerfile -t copilot-swe:latest .
#
# This is a PRIVILEGED tool (docs/security.md): it needs outbound network to
# GitHub + the Copilot API, a writable workspace, and a GitHub App / Copilot
# credential. Unlike the recipe tools it also bundles `git`, the GitHub CLI
# (`gh`), and the agentic GitHub Copilot CLI (`copilot`).

############################
# Build stage (compile the TS wrapper)
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/copilot-swe/package.json tools/copilot-swe/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/copilot-swe/tsconfig.json tools/copilot-swe/tsconfig.json
COPY tools/copilot-swe/src tools/copilot-swe/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=copilot-swe \
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

ARG GH_VERSION=2.63.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  # GitHub CLI (`gh`) — installed from the official release tarball rather than
  # adding an apt repo, to keep the image build hermetic.
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
     | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_${GH_VERSION}_linux_amd64" \
  # Agentic GitHub Copilot CLI.
  && npm install -g @github/copilot \
  && npm cache clean --force \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/copilot-swe/dist ./dist
COPY --from=build /repo/tools/copilot-swe/package.json ./package.json

# In-cluster the pod runs as uid 10001 (the tool-controller's hardened Job
# securityContext) with a read-only root filesystem; the wrapper writes all
# state under $HOME=/tmp/home on a writable emptyDir. For local `run.sh`
# testing it runs as the built-in unprivileged `node` user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
