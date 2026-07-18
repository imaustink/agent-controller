#!/usr/bin/env bash
#
# LOCAL DEV ONLY. In-cluster, this tool authenticates via its own pod's
# projected ServiceAccount token (see src/kubectl.ts) — no kubeconfig file is
# ever used there. Outside a cluster there is no ServiceAccount token to
# project, so this script instead runs `kubectl` directly against your local
# kubeconfig context (e.g. minikube) to exercise the allowlist/parsing logic
# without the container's in-cluster auth path.
#
# Usage: ./run.sh "get pods -n default"

set -euo pipefail

COMMAND="${1:?usage: ./run.sh \"<verb> <resource> [flags]\"}"
IMAGE="${KUBECTL_READONLY_IMAGE:-kubectl-readonly:latest}"

# Bypasses src/kubectl.ts's in-cluster auth (no KUBERNETES_SERVICE_HOST in this
# container) — this script is for exercising the tool against a real
# kubeconfig locally, so it shells kubectl directly instead of via the image's
# entrypoint. To test the actual container image end-to-end, run it as a Job
# in-cluster with the kubectl-readonly ServiceAccount (see rbac.yaml) instead.
exec docker run --rm \
  --name kubectl-readonly \
  --volume "${KUBECONFIG:-$HOME/.kube/config}:/home/node/.kube/config:ro" \
  --env "KUBECONFIG=/home/node/.kube/config" \
  --entrypoint kubectl \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  "$IMAGE" $COMMAND --request-timeout=10s
