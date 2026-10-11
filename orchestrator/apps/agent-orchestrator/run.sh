#!/usr/bin/env bash
#
# Hardened run contract for the agent-orchestrator container, matching the
# recipe-scraper contract (see docs/security.md): all Linux capabilities
# dropped, read-only root filesystem, no privilege escalation, resource
# limits capping blast radius.
#
# This is a long-lived service (ADR 0006), not a one-shot tool call: it
# stays running, serving the consumer-facing invoke API and the Job callback
# receiver, until stopped.
#
# Local/manual runs only — the orchestrator's real deployment is a k8s
# Deployment + Job/Pod RBAC (not yet written, see docs/orchestrator.md).
# Locally it needs network access to Qdrant, the OpenAI API, and a
# reachable kube-apiserver (via a mounted kubeconfig), so --network none is
# not applicable here (unlike recipe-scraper's URL-fetching subprocess).
#
# Usage: OPENAI_API_KEY=sk-... AGENT_CALLBACK_SECRET=... ./run.sh
#    or: put the vars in a .env file next to this script and run: ./run.sh
#
# Once running, call it (see ADR 0006 for the async invoke contract):
#   curl -X POST http://localhost:8081/invoke -H 'authorization: Bearer <token>' \
#     -H 'content-type: application/json' -d '{"request": "..."}'
#   curl http://localhost:8081/invoke/<id>

set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

IMAGE="${AGENT_IMAGE:-agent-orchestrator:latest}"

: "${OPENAI_API_KEY:?OPENAI_API_KEY is not set (add it to .env or export it)}"
: "${AGENT_CALLBACK_SECRET:?AGENT_CALLBACK_SECRET is not set (add it to .env or export it)}"

exec docker run --rm \
  --name agent-orchestrator \
  --env OPENAI_API_KEY \
  --env AGENT_CALLBACK_SECRET \
  --env "AGENT_NAMESPACE=${AGENT_NAMESPACE:-}" \
  --env "AGENT_QDRANT_URL=${AGENT_QDRANT_URL:-}" \
  --env "AGENT_QDRANT_API_KEY=${AGENT_QDRANT_API_KEY:-}" \
  --env "AGENT_CALLBACK_BASE_URL=${AGENT_CALLBACK_BASE_URL:-}" \
  --env "AGENT_CALLBACK_PORT=${AGENT_CALLBACK_PORT:-}" \
  --env "AGENT_HTTP_PORT=${AGENT_HTTP_PORT:-}" \
  --env "AGENT_STATIC_IDENTITIES=${AGENT_STATIC_IDENTITIES:-}" \
  --env "KUBECONFIG=/kube/config" \
  --volume "${KUBECONFIG:-$HOME/.kube/config}:/kube/config:ro" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --pids-limit 128 \
  --memory 1g \
  --memory-swap 1g \
  --cpus 1 \
  --publish "${AGENT_CALLBACK_PORT:-8080}:${AGENT_CALLBACK_PORT:-8080}" \
  --publish "${AGENT_HTTP_PORT:-8081}:${AGENT_HTTP_PORT:-8081}" \
  "$IMAGE"
