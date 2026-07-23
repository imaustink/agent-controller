# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/github/Dockerfile -t github:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/github/package.json tools/github/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/github/tsconfig.json tools/github/tsconfig.json
COPY tools/github/src tools/github/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=github \
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

# Pinned gh CLI release, verified against the sha256 checksums file published
# alongside the same release (fetched at build time rather than hardcoded, so
# the check stays correct if this ARG is bumped without also updating a stale
# hash). Bump GH_CLI_VERSION to upgrade. TARGETARCH is set automatically by
# BuildKit (amd64/arm64) and mapped to gh's own release asset naming.
ARG GH_CLI_VERSION=2.96.0
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && case "${TARGETARCH:-amd64}" in \
       amd64) GH_ARCH=amd64 ;; \
       arm64) GH_ARCH=arm64 ;; \
       *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz" -o /tmp/gh.tar.gz \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_checksums.txt" -o /tmp/gh_checksums.txt \
  && (cd /tmp && sha256sum -c <(grep "gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz" gh_checksums.txt)) \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && cp "/tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh \
  && chmod a+rx /usr/local/bin/gh \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /tmp/gh.tar.gz /tmp/gh_checksums.txt "/tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}"

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/github/dist ./dist
COPY --from=build /repo/tools/github/package.json ./package.json

# node:20-bookworm-slim ships an unprivileged 'node' user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
