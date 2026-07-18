# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f tools/signoz-query/Dockerfile -t signoz-query:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/signoz-query/package.json tools/signoz-query/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/signoz-query/tsconfig.json tools/signoz-query/tsconfig.json
COPY tools/signoz-query/src tools/signoz-query/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=signoz-query \
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

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/signoz-query/dist ./dist
COPY --from=build /repo/tools/signoz-query/package.json ./package.json

USER node

ENTRYPOINT ["node", "dist/index.js"]
