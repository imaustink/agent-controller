#!/usr/bin/env bash
#
# Hardened run contract for the github subagent container.
#
# The container is the security boundary here too: all Linux capabilities are
# dropped, the root filesystem is read-only, privilege escalation is
# disabled, and resource limits cap the blast radius. GITHUB_TOKEN
# authenticates gh as whoever the token belongs to -- in production this is
# the calling user's own identity-linked token (ADR 0022/0027), never a
# value baked into this script/image.
#
# Usage: GITHUB_TOKEN=ghp_... ./run.sh "issue view 86 --repo owner/repo"
#    or: put GITHUB_TOKEN in a .env file next to this script and run:
#        ./run.sh "issue view 86 --repo owner/repo"

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

GH_COMMAND="${1:?usage: ./run.sh \"<gh-command> [flags]\"}"
IMAGE="${GITHUB_TOOL_IMAGE:-github:latest}"

: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set (add it to .env or export it)}"

exec docker run --rm \
  --name github-tool \
  --env GITHUB_TOKEN \
  --env "GH_HOST=${GH_HOST:-github.com}" \
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
  "$IMAGE" "$GH_COMMAND"
