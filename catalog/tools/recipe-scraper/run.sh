#!/usr/bin/env bash
#
# Hardened run contract for the recipe-scraper subagent container.
#
# The container is the security boundary for untrusted content: all Linux
# capabilities are dropped, the root filesystem is read-only, privilege
# escalation is disabled, and resource limits cap the blast radius.
#
# SSRF note: the in-process URL guard blocks private/metadata addresses, but a
# DNS-rebinding attacker could still win the TOCTOU race. For defense in depth,
# run this container on a network whose egress is restricted to public hosts
# (e.g. a dedicated egress firewall / proxy). Replace the --network line below.
#
# Usage: OPENAI_API_KEY=sk-... ./run.sh <url>
#    or: put OPENAI_API_KEY in a .env file next to this script and run: ./run.sh <url>

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

URL="${1:?usage: ./run.sh <url>}"
IMAGE="${RECIPE_IMAGE:-recipe-scraper:latest}"

: "${OPENAI_API_KEY:?OPENAI_API_KEY is not set (add it to .env or export it)}"

exec docker run --rm \
  --name recipe-scraper \
  --env OPENAI_API_KEY \
  --env "OPENAI_BASE_URL=${OPENAI_BASE_URL:-}" \
  --env "RECIPE_TRANSPORT=${RECIPE_TRANSPORT:-}" \
  --env "RECIPE_JOB_ID=${RECIPE_JOB_ID:-}" \
  --env "RECIPE_CALLBACK_URL=${RECIPE_CALLBACK_URL:-}" \
  --env "RECIPE_CALLBACK_SECRET=${RECIPE_CALLBACK_SECRET:-}" \
  --env "RECIPE_CALLBACK_ALLOWED_HOSTS=${RECIPE_CALLBACK_ALLOWED_HOSTS:-}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --pids-limit 512 \
  --memory 2g \
  --memory-swap 2g \
  --cpus 2 \
  "$IMAGE" "$URL"
