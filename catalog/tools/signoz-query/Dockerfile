# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f catalog/tools/signoz-query/Dockerfile -t signoz-query:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY framework/messaging/package.json framework/messaging/package.json
COPY catalog/tools/signoz-query/package.json catalog/tools/signoz-query/package.json
RUN npm ci

COPY framework/messaging framework/messaging
COPY catalog/tools/signoz-query/tsconfig.json catalog/tools/signoz-query/tsconfig.json
COPY catalog/tools/signoz-query/src catalog/tools/signoz-query/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=signoz-query \
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

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/catalog/tools/signoz-query/dist ./dist
COPY --from=build /repo/catalog/tools/signoz-query/package.json ./package.json

USER node

ENTRYPOINT ["node", "dist/index.js"]
