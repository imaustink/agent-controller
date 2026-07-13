#!/usr/bin/env bash
# dev-up.sh — start minikube and (re)deploy the full recipe-agent stack.
#
# Usage:
#   ./scripts/dev-up.sh          # start everything
#   ./scripts/dev-up.sh --skip-build   # skip docker image builds (use cached)
#
# Prerequisites (one-time, out-of-band):
#   kubectl -n recipe-agent create secret generic agent-orchestrator-secrets \
#     --from-literal=OPENAI_API_KEY=<key> \
#     --from-literal=AGENT_CALLBACK_SECRET=<random-secret>
#
#   kubectl -n recipe-agent create secret generic recipe-publisher-secrets \
#     --from-literal=MEALIE_API_TOKEN=<token>
#
#   kubectl -n recipe-agent create secret generic agent-orchestrator-openwebui-google-oauth \
#     --from-literal=client-secret=<google-oauth-client-secret>
#
# All three secrets survive minikube restarts as long as the container is NOT
# recreated (i.e. normal start/stop). If the minikube container itself is
# deleted (as happened on 2026-07-12), you must re-create the secrets before
# running this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="recipe-agent"
SKIP_BUILD=false

for arg in "$@"; do
  [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=true
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
for sa in recipe-scraper recipe-publisher copilot-swe-agent; do
  kubectl -n "$NS" get serviceaccount "$sa" >/dev/null 2>&1 \
    || kubectl -n "$NS" create serviceaccount "$sa"
done

# ── 5. Helm dependencies ─────────────────────────────────────────────────────
step "Fetching Helm chart dependencies..."
# Helm does NOT recurse into nested subchart deps, so fetch the orchestrator
# subchart's qdrant first, then the umbrella's own open-webui. `helm dependency
# update` handles the unmanaged open-webui repo automatically (it also writes
# redundant local subchart .tgz alongside the unpacked dirs -- harmless, they're
# gitignored and Helm dedupes them at render time).
helm dependency update "$REPO_ROOT/charts/recipe-agent/charts/agent-orchestrator"
helm dependency update "$REPO_ROOT/charts/recipe-agent"

# ── 6. Docker images → minikube daemon ───────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  step "Building Docker images into minikube's daemon..."
  eval "$(minikube docker-env)"

  echo "  Building agent-orchestrator..."
  docker build -f "$REPO_ROOT/apps/agent-orchestrator/Dockerfile" \
    -t agent-orchestrator:latest "$REPO_ROOT" --quiet

  echo "  Building tool-controller..."
  docker build -f "$REPO_ROOT/controllers/tool-controller/Dockerfile" \
    -t tool-controller:latest "$REPO_ROOT/controllers/tool-controller" --quiet

  echo "  Building recipe-scraper..."
  docker build -f "$REPO_ROOT/tools/recipe-scraper/Dockerfile" \
    -t recipe-scraper:latest "$REPO_ROOT" --quiet

  echo "  Building recipe-publisher..."
  docker build -f "$REPO_ROOT/tools/recipe-publisher/Dockerfile" \
    -t recipe-publisher:latest "$REPO_ROOT" --quiet

  echo "  Building copilot-swe-agent..."
  docker build -f "$REPO_ROOT/apps/copilot-swe-agent/Dockerfile" \
    -t copilot-swe-agent:latest "$REPO_ROOT" --quiet

  # Return to the host daemon so subsequent docker commands work normally.
  eval "$(minikube docker-env --unset)"
else
  echo "  --skip-build: reusing cached images."
fi

# ── 7. CRDs ──────────────────────────────────────────────────────────────────
step "Applying CRDs..."
# Helm's crds/ dir is install-only; upgrades never touch them. Apply manually
# every time so CRD schema changes are always current.
for crd in "$REPO_ROOT"/charts/recipe-agent/charts/tool-controller/crds/*.yaml; do
  kubectl apply -f "$crd" --server-side >/dev/null
done

# ── 8. Helm release ──────────────────────────────────────────────────────────
step "Installing / upgrading the recipe-agent umbrella release..."
# One release, four subcharts (orchestrator + tool-controller + tools catalog +
# optional Open WebUI). The `tools` subchart applies the Tool/Skill CRs as
# post-install/post-upgrade hooks (after the controller), so no manual CR apply
# is needed here anymore. --wait blocks on the controller/orchestrator becoming
# ready before those hook CRs run.
helm upgrade --install recipe-agent "$REPO_ROOT/charts/recipe-agent" \
  --namespace "$NS" --wait --timeout 5m \
  -f "$REPO_ROOT/charts/recipe-agent/values-minikube-demo.yaml"

# ── 10. Rollout restart (picks up new images + refreshes CRD-sourced catalog) ─
step "Restarting deployments to pick up new images and updated CRs..."
kubectl -n "$NS" rollout restart deployment/agent-orchestrator
kubectl -n "$NS" rollout restart deployment/tool-controller 2>/dev/null || true
kubectl -n "$NS" rollout status deployment/agent-orchestrator --timeout=120s
kubectl -n "$NS" rollout status deployment/tool-controller --timeout=60s 2>/dev/null || true

# ── 11. Summary ──────────────────────────────────────────────────────────────
step "All done! Current pod state:"
kubectl -n "$NS" get pods

echo ""
echo "  Port-forward shortcuts:"
echo "    Open WebUI:  kubectl -n $NS port-forward svc/agent-orchestrator-openwebui 8080:80"
echo "    Invoke API:  kubectl -n $NS port-forward svc/agent-orchestrator-invoke 8081:8081"
