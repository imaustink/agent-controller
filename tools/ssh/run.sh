#!/usr/bin/env bash
#
# LOCAL DEV ONLY. Runs the built image against real SSH_PRIVATE_KEY/
# SSH_KNOWN_HOSTS and at least one of SSH_ALLOWED_HOSTS/SSH_CONFIG from your
# environment (see .env.example and README.md's "Resolving a target"),
# hardened the same way the in-cluster Job spec hardens it
# (core-controller's buildRunJob): no capabilities, read-only rootfs, a
# tmpfs /tmp for the materialized key/known_hosts files.
#
# Usage: ./run.sh "<target> <command> [args...]"
#   SSH_ALLOWED_HOSTS="monitor@nas.kurpuis.internal" \
#   SSH_PRIVATE_KEY="$(cat ~/.ssh/id_ed25519_monitor)" \
#   SSH_KNOWN_HOSTS="$(cat ~/.ssh/known_hosts)" \
#   ./run.sh "nas.kurpuis.internal df -h"

set -euo pipefail

COMMAND="${1:?usage: ./run.sh \"<target> <command> [args...]\"}"
IMAGE="${SSH_TOOL_IMAGE:-ssh:latest}"

if [ -z "${SSH_ALLOWED_HOSTS:-}" ] && [ -z "${SSH_CONFIG:-}" ]; then
  echo "At least one of SSH_ALLOWED_HOSTS or SSH_CONFIG is required." >&2
  exit 1
fi

# Passing `--env SSH_ALLOWED_HOSTS=` when the var is merely unset would set it
# to a DEFINED empty string inside the container -- config.ts's
# parseAllowedHosts() treats a defined-but-empty SSH_ALLOWED_HOSTS as a config
# error (distinct from "unset", which disables the allowlist feature), so
# only pass the optional env vars through when they actually have a value.
ENV_ARGS=()
[ -n "${SSH_ALLOWED_HOSTS:-}" ] && ENV_ARGS+=(--env "SSH_ALLOWED_HOSTS=${SSH_ALLOWED_HOSTS}")
[ -n "${SSH_CONFIG:-}" ] && ENV_ARGS+=(--env "SSH_CONFIG=${SSH_CONFIG}")
[ -n "${SSH_DEFAULT_USER:-}" ] && ENV_ARGS+=(--env "SSH_DEFAULT_USER=${SSH_DEFAULT_USER}")

exec docker run --rm \
  --name ssh-tool \
  "${ENV_ARGS[@]}" \
  --env "SSH_PRIVATE_KEY=${SSH_PRIVATE_KEY:?SSH_PRIVATE_KEY is required}" \
  --env "SSH_KNOWN_HOSTS=${SSH_KNOWN_HOSTS:?SSH_KNOWN_HOSTS is required}" \
  --env "RECIPE_TRANSPORT=${RECIPE_TRANSPORT:-stdout}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  "$IMAGE" "$COMMAND"
