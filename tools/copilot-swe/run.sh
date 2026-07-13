#!/usr/bin/env bash
#
# Hardened run contract for the copilot-swe subagent container.
#
# This is a PRIVILEGED tool: it needs outbound network (GitHub + Copilot API)
# and a larger writable workspace than the recipe tools. Capabilities are
# still dropped, privilege escalation disabled, and the root filesystem kept
# read-only (all writes go to the tmpfs workspace). The GitHub App / Copilot
# credentials are fixed configuration, never taken from the input instruction.
#
# Usage:
#   GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" \
#   COPILOT_GITHUB_TOKEN=github_pat_... ./run.sh '<instruction>'
# or put those in a .env file next to this script and run: ./run.sh '<instruction>'

set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

INSTRUCTION="${1:?usage: ./run.sh '<instruction>'}"
IMAGE="${COPILOT_SWE_IMAGE:-copilot-swe:latest}"

: "${GITHUB_APP_ID:?GITHUB_APP_ID is not set (add it to .env or export it)}"
: "${GITHUB_APP_PRIVATE_KEY:?GITHUB_APP_PRIVATE_KEY is not set (add it to .env or export it)}"
: "${COPILOT_GITHUB_TOKEN:?COPILOT_GITHUB_TOKEN is not set (add it to .env or export it)}"

exec docker run --rm \
  --name copilot-swe \
  --env GITHUB_APP_ID \
  --env "GITHUB_APP_INSTALLATION_ID=${GITHUB_APP_INSTALLATION_ID:-}" \
  --env GITHUB_APP_PRIVATE_KEY \
  --env COPILOT_GITHUB_TOKEN \
  --env "COPILOT_MODEL=${COPILOT_MODEL:-}" \
  --env "GITHUB_API_URL=${GITHUB_API_URL:-}" \
  --env "RECIPE_TRANSPORT=${RECIPE_TRANSPORT:-}" \
  --env "RECIPE_JOB_ID=${RECIPE_JOB_ID:-}" \
  --env "RECIPE_CALLBACK_URL=${RECIPE_CALLBACK_URL:-}" \
  --env "RECIPE_CALLBACK_SECRET=${RECIPE_CALLBACK_SECRET:-}" \
  --env "RECIPE_CALLBACK_ALLOWED_HOSTS=${RECIPE_CALLBACK_ALLOWED_HOSTS:-}" \
  --env "HOME=/tmp/home" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=2g \
  --pids-limit 512 \
  --memory 2g \
  --memory-swap 2g \
  --cpus 2 \
  "$IMAGE" "$INSTRUCTION"
