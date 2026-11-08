#!/usr/bin/env bash
#
# Hardened run contract for the web-fetch subagent container.
#
# The container is the security boundary for untrusted content: all Linux
# capabilities are dropped, the root filesystem is read-only, privilege
# escalation is disabled, and resource limits cap the blast radius.
#
# SSRF note: the in-process URL guard blocks private/metadata addresses, but a
# DNS-rebinding attacker could still win the TOCTOU race. For defense in depth,
# run this container on a network whose egress is restricted to public hosts
# (e.g. a dedicated egress firewall / proxy).
#
# Usage: ./run.sh <url>
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

URL="${1:?usage: ./run.sh <url>}"
IMAGE="${WEB_FETCH_IMAGE:-web-fetch:latest}"

exec docker run --rm \
  --name web-fetch \
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
  "$IMAGE" "$URL"
