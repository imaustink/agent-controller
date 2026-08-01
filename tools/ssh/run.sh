#!/usr/bin/env bash
#
# LOCAL DEV ONLY. Runs the built image against real SSH_ALLOWED_HOSTS/
# SSH_PRIVATE_KEY/SSH_KNOWN_HOSTS from your environment (see .env.example),
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

exec docker run --rm \
  --name ssh-tool \
  --env "SSH_ALLOWED_HOSTS=${SSH_ALLOWED_HOSTS:?SSH_ALLOWED_HOSTS is required}" \
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
