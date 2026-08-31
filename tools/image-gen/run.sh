#!/usr/bin/env bash
#
# Hardened run contract for the image-gen subagent container.
#
# All Linux capabilities are dropped, the root filesystem is read-only,
# privilege escalation is disabled, and resource limits cap the blast radius.
# The container needs egress to the OpenAI API and the configured S3-compatible
# object store; run it on a network whose egress is restricted accordingly.
#
# Usage: ./run.sh '{"prompt":"a bowl of ramen, studio photo"}'
#        ./run.sh '{"prompt":"add a soft-boiled egg on top","image_url":"https://.../prev.png"}'
#        ./run.sh 'a bare prompt string also works'
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

INPUT="${1:?usage: ./run.sh <json-or-prompt>}"
IMAGE="${IMAGE_GEN_IMAGE:-image-gen:latest}"

exec docker run --rm \
  --name image-gen \
  --env "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
  --env "OPENAI_BASE_URL=${OPENAI_BASE_URL:-}" \
  --env "IMAGE_MODEL=${IMAGE_MODEL:-}" \
  --env "IMAGE_SIZE=${IMAGE_SIZE:-}" \
  --env "IMAGE_QUALITY=${IMAGE_QUALITY:-}" \
  --env "IMAGE_S3_ENDPOINT=${IMAGE_S3_ENDPOINT:-}" \
  --env "IMAGE_S3_REGION=${IMAGE_S3_REGION:-}" \
  --env "IMAGE_S3_BUCKET=${IMAGE_S3_BUCKET:-}" \
  --env "IMAGE_S3_PREFIX=${IMAGE_S3_PREFIX:-}" \
  --env "IMAGE_S3_PRESIGN_TTL_SECONDS=${IMAGE_S3_PRESIGN_TTL_SECONDS:-}" \
  --env "IMAGE_S3_FORCE_PATH_STYLE=${IMAGE_S3_FORCE_PATH_STYLE:-}" \
  --env "IMAGE_S3_ACCESS_KEY_ID=${IMAGE_S3_ACCESS_KEY_ID:-}" \
  --env "IMAGE_S3_SECRET_ACCESS_KEY=${IMAGE_S3_SECRET_ACCESS_KEY:-}" \
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
  --memory 512m \
  --memory-swap 512m \
  --cpus 1 \
  "$IMAGE" "$INPUT"
