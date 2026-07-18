# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this app depends on the shared
# @controller-agent/messaging workspace package):
#
#   docker build -f apps/integration-gateway/Dockerfile -t integration-gateway:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY apps/integration-gateway/package.json apps/integration-gateway/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY apps/integration-gateway/tsconfig.json apps/integration-gateway/tsconfig.json
COPY apps/integration-gateway/src apps/integration-gateway/src

RUN npm run build --workspace=@controller-agent/messaging \
  && npm run build --workspace=integration-gateway \
  && npm prune --omit=dev \
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
COPY --from=build /repo/apps/integration-gateway/dist ./dist
COPY --from=build /repo/apps/integration-gateway/package.json ./package.json

RUN useradd --system --uid 10001 --create-home gateway
USER gateway

ENTRYPOINT ["node", "dist/index.js"]
