#!/usr/bin/env bash
# up.sh — bring the whole e2e stack up on minikube, from nothing to ready.
#
# Usage:  ./e2e/scripts/up.sh
#
# This is the ONE entry point for the e2e environment. It exists because
# getting here by hand requires knowing three non-obvious things, each of
# which produced a confusing failure the first time through:
#
#   1. Helm does not recurse into file:// subcharts. `skaffold run` builds
#      charts/agent-controller's dependencies but NOT agent-orchestrator's own
#      qdrant dependency, so qdrant is silently never deployed and the
#      orchestrator crashloops on "qdrant startup check failed" while Helm
#      reports the far less helpful "context deadline exceeded".
#   2. The gateway secret must be created BEFORE the deploy and must not use
#      the chart's own generated name, or Helm refuses to adopt it
#      ("invalid ownership metadata") and rolls the release back.
#   3. The default skaffold profile never builds integration-gateway, because
#      the demo profile leaves that component disabled — but the e2e suite's
#      entry point is a webhook hitting exactly that gateway.
#
# Idempotent: safe to re-run after a failure or a code change.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS="controller-agent"
CTX="minikube"

step() { echo ""; echo "▶ $*"; }

CURRENT="$(kubectl config current-context 2>/dev/null || true)"
if [[ "$CURRENT" != "$CTX" ]]; then
  echo "✗ kubectl context is '$CURRENT', not '$CTX'. Refusing to deploy." >&2
  echo "  Switch with:  kubectl config use-context $CTX" >&2
  exit 1
fi

step "Fetching nested subchart dependencies (Helm won't recurse into these)..."
# The top-level chart's deps are handled by skaffold (skipBuildDependencies:
# false). This is the nested one it cannot see -- see note 1 in the header.
helm dependency update "$REPO_ROOT/charts/agent-controller/charts/agent-orchestrator" >/dev/null
echo "  ✓ qdrant"

step "Applying CRDs..."
# Helm's crds/ directory is INSTALL-ONLY -- `helm upgrade` never touches it.
# So a cluster whose release predates a newly-added CRD never gets it, and the
# orchestrator crashloops with a bare `404 page not found` from the API server
# while listing that resource. This is exactly how `integrationroutes` came to
# be missing here: every other CRD existed, from an older install.
#
# NOTE: dev-up.sh applies these from charts/agent-controller/charts/
# core-controller/crds/, which no longer exists. The generated bases below are
# the real source.
for crd in "$REPO_ROOT"/controllers/core-controller/config/crd/bases/*.yaml; do
  kubectl apply -f "$crd" --server-side --force-conflicts >/dev/null
done
echo "  ✓ $(ls "$REPO_ROOT"/controllers/core-controller/config/crd/bases/*.yaml | wc -l | tr -d ' ') CRDs"

step "Creating throwaway secrets..."
"$REPO_ROOT/e2e/scripts/bootstrap-secrets.sh"

step "Deploying the Temporal dev server (e2e/manifests/temporal-dev-server.yaml)..."
# The chart defaults `temporal-engine.enabled: true` +
# `agent-orchestrator.config.agentEngine: temporal` (docs/adr/0036), so every
# turn now routes through the Temporal engine's worker/gateway -- but no
# subchart bundles an actual Temporal server. Without one reachable BEFORE the
# release below, the worker/gateway Pods crashloop on their first connection
# attempt and every agent turn in the suite hangs. Applied idempotently, same
# as the CRDs above.
kubectl apply -n "$NS" -f "$REPO_ROOT/e2e/manifests/temporal-dev-server.yaml" >/dev/null
kubectl -n "$NS" wait --for=condition=Available --timeout=120s deploy/temporal-dev-server >/dev/null
echo "  ✓ temporal-dev-server"

step "Adopting hand-created objects into Helm..."
# dev-up.sh creates these ServiceAccounts with `kubectl create serviceaccount`,
# but community-components' templates also declare them. Helm refuses to adopt
# an object it didn't create ("invalid ownership metadata") and fails the
# WHOLE release, so any cluster that ever ran dev-up.sh blocks this deploy.
#
# Labelling is non-destructive and preserves existing RoleBindings, unlike
# deleting and letting Helm recreate them.
for sa in recipe-scraper recipe-publisher opencode-swe-agent web-search claude-code-swe-agent; do
  if kubectl -n "$NS" get sa "$sa" >/dev/null 2>&1; then
    kubectl -n "$NS" label sa "$sa" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
    kubectl -n "$NS" annotate sa "$sa" \
      meta.helm.sh/release-name=community-components \
      meta.helm.sh/release-namespace="$NS" --overwrite >/dev/null
  fi
done
echo "  ✓ ServiceAccounts"

step "Building images and deploying (skaffold profile: e2e)..."
# If you are ever debugging behaviour that "the code clearly does not do any
# more", suspect the image before the logic. Skaffold decides whether to rebuild
# an artifact from a dependency list IT resolves from the Dockerfile + the
# .dockerignore, and a .dockerignore it can't evaluate yields a list that never
# changes -- so it silently re-tags an old image for every new commit. That
# shipped an eight-day-old core-controller here, presenting as a rendered Job
# missing its per-run secretEnv (see controllers/core-controller/.dockerignore).
#
# Check with:  skaffold diagnose -p e2e | grep -A3 'Docker artifact: <name>'
# A dependency count far below the artifact's real source-file count is the tell.
(cd "$REPO_ROOT" && skaffold run -p e2e)

step "Waiting for the stack to be ready..."
# `helm --wait` already gates on this, but it is re-checked explicitly so a
# partially-ready cluster fails HERE with a readable pod list rather than
# inside a test's waitFor timeout, where it looks like a product bug.
kubectl -n "$NS" wait --for=condition=Available --timeout=300s \
  deploy/agent-orchestrator deploy/agent-controller-integration-gateway

echo ""
echo "✓ e2e stack is up. Run the suite with:"
echo "    npm run e2e -w e2e"
