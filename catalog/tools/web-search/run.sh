#!/usr/bin/env bash
#
# Hardened run contract for the web-search subagent container.
#
# The container is the security boundary here too: all Linux capabilities are
# dropped, the root filesystem is read-only, privilege escalation is
# disabled, and resource limits cap the blast radius. The SearXNG target
# (base URL) is fixed configuration, never taken from the input argument.
#
# Usage: SEARXNG_BASE_URL=http://searxng:8080 ./run.sh 'search query'
#    or: put SEARXNG_BASE_URL in a .env file next to this script and run: ./run.sh 'search query'
#
# NOTE: the messaging env vars below are RECIPE_* -- that's core-controller's
# actual wire protocol for every tool (see src/config.ts), not recipe-specific.

set -euo pipefail

# Auto-load a local .env (KEY=VALUE lines) if present, without overriding
# variables already set in the environment.
ENV_FILE="$(dirname "$0")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

QUERY="${1:?usage: ./run.sh 'search query'}"
IMAGE="${WEB_SEARCH_IMAGE:-web-search:latest}"

: "${SEARXNG_BASE_URL:?SEARXNG_BASE_URL is not set (add it to .env or export it)}"

exec docker run --rm \
  --name web-search \
  --env SEARXNG_BASE_URL \
  --env "RECIPE_TRANSPORT=${RECIPE_TRANSPORT:-}" \
  --env "RECIPE_JOB_ID=${RECIPE_JOB_ID:-}" \
  --env "RECIPE_CALLBACK_URL=${RECIPE_CALLBACK_URL:-}" \
  --env "RECIPE_CALLBACK_SECRET=${RECIPE_CALLBACK_SECRET:-}" \
  --env "RECIPE_CALLBACK_ALLOWED_HOSTS=${RECIPE_CALLBACK_ALLOWED_HOSTS:-}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --pids-limit 128 \
  --memory 256m \
  --memory-swap 256m \
  --cpus 1 \
  "$IMAGE" "$QUERY"
