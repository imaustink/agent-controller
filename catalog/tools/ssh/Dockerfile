# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f catalog/tools/ssh/Dockerfile -t ssh:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY framework/messaging/package.json framework/messaging/package.json
COPY catalog/tools/ssh/package.json catalog/tools/ssh/package.json
RUN npm ci

COPY framework/messaging framework/messaging
COPY catalog/tools/ssh/tsconfig.json catalog/tools/ssh/tsconfig.json
COPY catalog/tools/ssh/src catalog/tools/ssh/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=ssh \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@controller-agent/messaging \
  && mkdir -p node_modules/@controller-agent/messaging \
  && cp -r framework/messaging/dist node_modules/@controller-agent/messaging/dist \
  && cp framework/messaging/package.json node_modules/@controller-agent/messaging/package.json

############################
# Runtime stage
############################
FROM node:20-bookworm-slim AS runtime

# openssh-client provides /usr/bin/ssh -- no other SSH-adjacent packages
# (sshd, ssh-agent, autossh) are installed; this container only ever dials
# out with a single non-interactive command per invocation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# core-controller's ToolRun Job spec force-runs every Tool container as
# uid/gid 10001 (orchestrator/controllers/core-controller/internal/controller/
# run_job.go's jobRunAsUser/jobRunAsGroup) with a read-only root filesystem,
# regardless of this image's own USER -- so /etc/passwd needs a REAL,
# build-time entry for 10001. OpenSSH's own ssh(1) does an unconditional
# getpwuid() on startup and fatals ("No user exists for uid 10001") if that
# lookup fails; no ssh flag or $HOME/$USER env var bypasses it (ssh.ts spawns
# with an empty env). -M (no home dir created): nothing here reads $HOME --
# the private key/known_hosts are materialized under /tmp instead (ssh.ts).
RUN groupadd -g 10001 sshtool \
  && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin sshtool

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/catalog/tools/ssh/dist ./dist
COPY --from=build /repo/catalog/tools/ssh/package.json ./package.json

# Matches the uid core-controller's ToolRun Job actually runs this
# container as in the cluster (see the groupadd/useradd above) -- not
# node:20-bookworm-slim's own default 'node' user (uid 1000), which the
# Job's PodSecurityContext overrides anyway. Set here too so a local
# `docker run` (catalog/tools/ssh/run.sh) exercises the same uid/passwd-entry path.
USER 10001

ENTRYPOINT ["node", "dist/index.js"]
