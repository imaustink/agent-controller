# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/ssh/Dockerfile -t ssh:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/ssh/package.json tools/ssh/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/ssh/tsconfig.json tools/ssh/tsconfig.json
COPY tools/ssh/src tools/ssh/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=ssh \
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

# openssh-client provides /usr/bin/ssh -- no other SSH-adjacent packages
# (sshd, ssh-agent, autossh) are installed; this container only ever dials
# out with a single non-interactive command per invocation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/ssh/dist ./dist
COPY --from=build /repo/tools/ssh/package.json ./package.json

# node:20-bookworm-slim ships an unprivileged 'node' user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
