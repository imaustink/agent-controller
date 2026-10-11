#!/usr/bin/env bash
#
# Hardened run contract for the glyph subagent container.
#
# The container is the security boundary: all Linux capabilities are dropped,
# the root filesystem is read-only, privilege escalation is disabled, and
# resource limits cap the blast radius. GLYPH_TOKEN authenticates the request
# as whoever the token belongs to -- in production this is the calling user's
# own OAuth-delegated token (Glyph's per-user delegation), injected
# per-invocation via ToolRunSpec.secretEnv, never a value baked into this
# script/image.
#
# Usage: GLYPH_BASE_URL=https://glyph.example.com GLYPH_TOKEN=... \
#          ./run.sh '{"resource":"task","action":"search","status":"todo"}'
#    or: put GLYPH_BASE_URL/GLYPH_TOKEN in a .env file next to this script and
#        run: ./run.sh '{"resource":"note","action":"get","id":"<uuid>"}'

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

GLYPH_COMMAND="${1:?usage: ./run.sh '<json-command>'}"
IMAGE="${GLYPH_TOOL_IMAGE:-glyph:latest}"

: "${GLYPH_BASE_URL:?GLYPH_BASE_URL is not set (add it to .env or export it)}"
: "${GLYPH_TOKEN:?GLYPH_TOKEN is not set (add it to .env or export it)}"

exec docker run --rm \
  --name glyph-tool \
  --env GLYPH_BASE_URL \
  --env GLYPH_TOKEN \
  --env "GLYPH_FETCH_TIMEOUT_MS=${GLYPH_FETCH_TIMEOUT_MS:-}" \
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
  "$IMAGE" "$GLYPH_COMMAND"
