#!/usr/bin/env bash
# dev-up.sh — one-time/rare cluster prep, then hand off to Skaffold for the
# actual build+deploy (see skaffold.yaml at repo root).
#
# Usage:
#   ./scripts/dev-up.sh              # prep, then `skaffold run` (one-shot deploy)
#   ./scripts/dev-up.sh --dev        # prep, then `skaffold dev` (watch + redeploy loop)
#   ./scripts/dev-up.sh --prep-only  # just the prep steps below, no skaffold invocation
#
# Everything here is either a true one-time prerequisite or something
# Skaffold's helm deployer has no hook mechanism for (only its kubectl
# deployer supports before/after hooks) — see the "Prerequisites this file
# deliberately does NOT own" comment in skaffold.yaml.
#
# Prerequisites (one-time, out-of-band):
#   kubectl -n controller-agent create secret generic agent-orchestrator-secrets \
#     --from-literal=OPENAI_API_KEY=<key> \
#     --from-literal=AGENT_CALLBACK_SECRET=<random-secret>
#
#   kubectl -n controller-agent create secret generic recipe-publisher-secrets \
#     --from-literal=MEALIE_API_TOKEN=<token>
#
#   kubectl -n controller-agent create secret generic agent-orchestrator-openwebui-google-oauth \
#     --from-literal=client-secret=<google-oauth-client-secret>
#
# All three secrets survive minikube restarts as long as the container is NOT
# recreated (i.e. normal start/stop). If the minikube container itself is
# deleted (as happened on 2026-07-12), you must re-create the secrets before
# running this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="controller-agent"
MODE="run"

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --prep-only) MODE="none" ;;
  esac
done

step() { echo ""; echo "▶ $*"; }
die()  { echo "✗ $*" >&2; exit 1; }

# ── 0. Docker ────────────────────────────────────────────────────────────────
step "Checking Docker..."
if ! docker info >/dev/null 2>&1; then
  echo "  Docker is not running. Launching Docker Desktop..."
  open -a Docker
  echo "  Waiting for Docker daemon..."
  until docker info >/dev/null 2>&1; do sleep 2; done
  echo "  Docker is up."
fi

# ── 1. minikube ──────────────────────────────────────────────────────────────
step "Starting minikube..."
# Pass --memory and --cpus so a freshly-recreated profile (after minikube
# delete) gets the right limits. Flags are silently ignored when the
# container already exists and is just being restarted.
minikube start --memory=6144 --cpus=4 --driver=docker

# Safety check: make sure we're pointing at minikube, not a real cluster.
# Skaffold auto-targets minikube's Docker daemon based on this same context.
CURRENT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
if [[ "$CURRENT_CONTEXT" != "minikube" ]]; then
  die "kubectl context is '$CURRENT_CONTEXT', not 'minikube'. Aborting to avoid touching the wrong cluster."
fi

# ── 2. Namespace ─────────────────────────────────────────────────────────────
step "Ensuring namespace '$NS'..."
kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"

# ── 3. Secrets check ─────────────────────────────────────────────────────────
step "Checking required secrets..."
MISSING_SECRETS=()
for secret in agent-orchestrator-secrets recipe-publisher-secrets agent-orchestrator-openwebui-google-oauth; do
  if ! kubectl -n "$NS" get secret "$secret" >/dev/null 2>&1; then
    MISSING_SECRETS+=("$secret")
  fi
done
if [[ ${#MISSING_SECRETS[@]} -gt 0 ]]; then
  echo ""
  echo "✗ The following secrets are missing from namespace '$NS':" >&2
  for s in "${MISSING_SECRETS[@]}"; do echo "    - $s" >&2; done
  echo "" >&2
  echo "  Create them yourself in a terminal (see script header for the exact commands)," >&2
  echo "  then re-run this script." >&2
  exit 1
fi

# ── 4. ServiceAccounts ───────────────────────────────────────────────────────
step "Ensuring tool ServiceAccounts..."
for sa in recipe-scraper recipe-publisher opencode-swe-agent; do
  kubectl -n "$NS" get serviceaccount "$sa" >/dev/null 2>&1 \
    || kubectl -n "$NS" create serviceaccount "$sa"
done

# ── 5. Nested Helm dependency (Helm doesn't recurse into file:// subcharts) ──
step "Fetching agent-orchestrator's own subchart dependency (qdrant)..."
helm dependency update "$REPO_ROOT/charts/agent-controller/charts/agent-orchestrator"

# ── 6. CRDs ──────────────────────────────────────────────────────────────────
step "Applying CRDs..."
# Helm's crds/ dir is install-only; upgrades never touch them. Apply manually
# every time so CRD schema changes are always current. These CRDs are what
# the (separately-released) community-components chart's Tool/Skill/Agent CRs
# depend on.
for crd in "$REPO_ROOT"/charts/agent-controller/charts/tool-controller/crds/*.yaml; do
  kubectl apply -f "$crd" --server-side >/dev/null
done

# ── 7. Hand off to Skaffold ───────────────────────────────────────────────────
case "$MODE" in
  run)
    step "Building images and deploying via Skaffold (one-shot)..."
    (cd "$REPO_ROOT" && skaffold run)
    ;;
  dev)
    step "Building images and deploying via Skaffold (watch mode)..."
    (cd "$REPO_ROOT" && skaffold dev)
    ;;
  none)
    step "Prep done. Run 'skaffold run' or 'skaffold dev' from $REPO_ROOT when ready."
    ;;
esac

echo ""
echo "  Port-forward shortcuts:"
echo "    Open WebUI:  kubectl -n $NS port-forward svc/agent-orchestrator-openwebui 8080:80"
echo "    Invoke API:  kubectl -n $NS port-forward svc/agent-orchestrator-invoke 8081:8081"
