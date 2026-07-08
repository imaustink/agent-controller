# syntax=docker/dockerfile:1
#
# Build from the REPO ROOT (this tool depends on the shared
# @recipe-agent/messaging workspace package):
#
#   docker build -f tools/recipe-scraper/Dockerfile -t recipe-scraper:latest .

############################
# Build stage
############################
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Browsers already ship in the runtime image; don't download them here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install across the whole workspace so the local @recipe-agent/messaging
# package resolves without hitting the registry.
COPY package.json package-lock.json* ./
COPY packages/messaging/package.json packages/messaging/package.json
COPY tools/recipe-scraper/package.json tools/recipe-scraper/package.json
RUN npm ci

COPY packages/messaging packages/messaging
COPY tools/recipe-scraper/tsconfig.json tools/recipe-scraper/tsconfig.json
COPY tools/recipe-scraper/src tools/recipe-scraper/src

RUN npm run build --workspace=@recipe-agent/messaging \
  && npm run build --workspace=recipe-scraper \
  && npm prune --omit=dev \
  # Materialize the workspace package into a real directory (not the npm-created
  # symlink) so it survives being copied into the runtime stage below.
  && rm -rf node_modules/@recipe-agent/messaging \
  && mkdir -p node_modules/@recipe-agent/messaging \
  && cp -r packages/messaging/dist node_modules/@recipe-agent/messaging/dist \
  && cp packages/messaging/package.json node_modules/@recipe-agent/messaging/package.json

############################
# Runtime stage
############################
# Pinned Playwright image bundles Chromium + its OS dependencies.
# Keep this version in lockstep with the "playwright" dependency in package.json.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS runtime

# yt-dlp (pinned) + ffmpeg for audio extraction/transcription.
# yt-dlp must stay current: YouTube et al. change constantly, so an old build
# breaks (e.g. "Sign in to confirm you're not a bot"). Defaults to the latest
# release; set YT_DLP_VERSION to a tag (e.g. 2025.06.30) to pin for reproducibility.
ARG YT_DLP_VERSION=latest
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && if [ "$YT_DLP_VERSION" = "latest" ]; then \
       YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"; \
     else \
       YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp"; \
     fi \
  && curl -fsSL "$YT_DLP_URL" -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/tools/recipe-scraper/dist ./dist
COPY --from=build /repo/tools/recipe-scraper/package.json ./package.json

# The Playwright base image provides an unprivileged 'pwuser'.
USER pwuser

ENTRYPOINT ["node", "dist/index.js"]
