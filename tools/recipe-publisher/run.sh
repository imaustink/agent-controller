#!/usr/bin/env bash
#
# Hardened run contract for the recipe-publisher subagent container.
#
# The container is the security boundary here too: all Linux capabilities are
# dropped, the root filesystem is read-only, privilege escalation is
# disabled, and resource limits cap the blast radius. The Mealie publish
# target (base URL) is fixed configuration, never taken from the input
# argument.
#
# Usage: MEALIE_BASE_URL=https://recipes.example.com MEALIE_API_TOKEN=... ./run.sh '<recipe-markdown>'
#    or: put MEALIE_BASE_URL/MEALIE_API_TOKEN in a .env file next to this script and run: ./run.sh '<recipe-markdown>'

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

RECIPE_MARKDOWN="${1:?usage: ./run.sh '<recipe-markdown>'}"
IMAGE="${RECIPE_PUBLISHER_IMAGE:-recipe-publisher:latest}"

: "${MEALIE_BASE_URL:?MEALIE_BASE_URL is not set (add it to .env or export it)}"
: "${MEALIE_API_TOKEN:?MEALIE_API_TOKEN is not set (add it to .env or export it)}"

exec docker run --rm \
  --name recipe-publisher \
  --env MEALIE_BASE_URL \
  --env MEALIE_API_TOKEN \
  --env "MEALIE_INGREDIENT_PARSER=${MEALIE_INGREDIENT_PARSER:-}" \
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
  "$IMAGE" "$RECIPE_MARKDOWN"
