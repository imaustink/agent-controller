# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging and @controller-agent/github-app-auth workspace
# packages):
#
#   docker build -f tools/github/Dockerfile -t github:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY packages/github-app-auth/package.json packages/github-app-auth/package.json
COPY tools/github/package.json tools/github/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY packages/github-app-auth packages/github-app-auth
COPY tools/github/tsconfig.json tools/github/tsconfig.json
COPY tools/github/src tools/github/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=@controller-agent/github-app-auth \
  && npm run build --workspace=github \
  && npm prune --omit=dev \
  # Materialize the workspace packages into real directories (not the
  # npm-created symlinks) so they survive being copied into the runtime stage
  # below.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r packages/messaging/dist node_modules/@controller-agent/messaging/dist \
  && cp packages/messaging/package.json node_modules/@controller-agent/messaging/package.json \
  && rm -rf node_modules/@controller-agent/github-app-auth \
  && mkdir -p node_modules/@controller-agent/github-app-auth \
  && cp -r packages/github-app-auth/dist node_modules/@controller-agent/github-app-auth/dist \
  && cp packages/github-app-auth/package.json node_modules/@controller-agent/github-app-auth/package.json

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
  # Saved under the asset's PUBLISHED name, not a convenience name: the names in
  # the checksums file are what `sha256sum -c` opens, so downloading this to
  # /tmp/gh.tar.gz made verification fail on a missing file every time.
  && GH_TARBALL="gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${GH_TARBALL}" -o "/tmp/${GH_TARBALL}" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_checksums.txt" -o /tmp/gh_checksums.txt \
  # Filtered through a temp FILE rather than process substitution: `<(...)` is a
  # bashism and Debian's /bin/sh is dash, which rejects it outright with
  # `Syntax error: "(" unexpected` -- so this layer could never build at all.
  && grep " ${GH_TARBALL}$" /tmp/gh_checksums.txt > /tmp/gh_checksum.txt \
  # A checksums file that stops listing this asset must fail the build rather
  # than silently verify nothing.
  && test -s /tmp/gh_checksum.txt \
  && (cd /tmp && sha256sum -c gh_checksum.txt) \
  && tar -xzf "/tmp/${GH_TARBALL}" -C /tmp \
  && cp "/tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh \
  && chmod a+rx /usr/local/bin/gh \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* "/tmp/${GH_TARBALL}" /tmp/gh_checksums.txt /tmp/gh_checksum.txt "/tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}"

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/github/dist ./dist
COPY --from=build /repo/tools/github/package.json ./package.json

# node:20-bookworm-slim ships an unprivileged 'node' user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
