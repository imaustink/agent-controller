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
#
# ENGINE: E2E_ENGINE=temporal (default) or E2E_ENGINE=langgraph selects which
# agent engine agent-orchestrator drives turns with (docs/adr/0036). The chart
# and values-e2e.yaml deploy Temporal; for langgraph this script clears
# agent-orchestrator.config.agentEngine on the release after skaffold deploys
# it (temporal-engine stays deployed and idle -- the documented rollback shape).
# Run the suite with the SAME E2E_ENGINE: e2e/support/engine.ts refuses to run
# against a cluster serving the other one.
#
#   E2E_ENGINE=langgraph ./e2e/scripts/up.sh
#   E2E_ENGINE=langgraph npm run e2e -w e2e
#
# E2E_SKIP_WEB_FETCH_BUILD=1 skips building the web-fetch Tool image (see below).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS="controller-agent"
CTX="minikube"
ENGINE="${E2E_ENGINE:-temporal}"

step() { echo ""; echo "▶ $*"; }

if [[ "$ENGINE" != "temporal" && "$ENGINE" != "langgraph" ]]; then
  echo "✗ E2E_ENGINE must be 'temporal' or 'langgraph', got '$ENGINE'." >&2
  exit 1
fi

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

step "Deploying the fake providers (e2e/manifests/fake-*.yaml)..."
# The connection-broker is pointed at this by values-e2e.yaml. It must exist
# BEFORE the release, or the first sync CronJob fires against a Service with no
# endpoints and the corpus comes up empty for a reason no assertion names.
for fake in fake-confluence fake-slack fake-gdrive fake-jazzhr; do
  kubectl apply -n "$NS" -f "$REPO_ROOT/e2e/manifests/$fake.yaml" >/dev/null
  kubectl -n "$NS" wait --for=condition=Available --timeout=120s "deploy/$fake" >/dev/null
  echo "  ✓ $fake"
done
# fake-sink: where the event triggers' reply.http side-effects land
# (values-e2e.yaml points them at it). Applied with the same config checksum
# e2e/support/fake-sink.ts's ensureFakeSink() computes (sha256 of the file,
# first 16 hex), so the spec's own re-apply is a no-op instead of a roll.
SINK="$REPO_ROOT/e2e/manifests/fake-sink.yaml"
SINK_SUM="$(shasum -a 256 "$SINK" | cut -c1-16)"
sed "s/REPLACED_AT_APPLY/$SINK_SUM/" "$SINK" | kubectl apply -n "$NS" -f - >/dev/null
kubectl -n "$NS" rollout status deploy/fake-sink --timeout=120s >/dev/null
echo "  ✓ fake-sink"

step "Building the web-fetch Tool image into minikube..."
# The generic-hmac -> web-fetch EventTrigger runs this Tool as a ToolRun Job,
# and the Tool CR (values-minikube-demo.yaml enables it) pins `web-fetch:latest`
# -- but the e2e skaffold profile does not build it, so on a fresh minikube the
# run sits in ErrImageNeverPull/ImagePullBackOff and the spec times out naming
# neither. Built straight into minikube's runtime; run Jobs pull IfNotPresent.
if [[ "${E2E_SKIP_WEB_FETCH_BUILD:-}" == "1" ]]; then
  echo "  - skipped (E2E_SKIP_WEB_FETCH_BUILD=1)"
else
  (cd "$REPO_ROOT" && minikube -p "$CTX" image build -t web-fetch:latest -f tools/web-fetch/Dockerfile . >/dev/null)
  echo "  ✓ web-fetch:latest"
fi

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
#
# --tolerate-failures-until-deadline: skaffold stamps a fresh run-id label on
# every pod template, so EVERY run rolls NATS and Qdrant alongside the
# orchestrator, which can exit once while they come back. Without the flag the
# status check fails the whole run on that first exit, although the stack
# converges seconds later.
(cd "$REPO_ROOT" && skaffold run -p e2e --tolerate-failures-until-deadline)

step "Applying the example EventSources/EventTriggers..."
# examples/event-triggers is not in any chart (ADR 0048); the suite runs the
# shipped examples through an overlay that only swaps in hermetic agents,
# Secrets and reply sinks. After skaffold, so the CRDs and the Agents/Skills/
# Tools the triggers name already exist.
kubectl apply -n "$NS" -k "$REPO_ROOT/e2e/manifests/event-triggers" >/dev/null
echo "  ✓ e2e/manifests/event-triggers"

step "Selecting the agent engine: $ENGINE..."
# skaffold just (re)applied values-e2e.yaml, which deploys Temporal -- so a
# temporal run needs nothing here, and re-running up.sh without E2E_ENGINE
# always puts a langgraph cluster back on Temporal.
if [[ "$ENGINE" == "langgraph" ]]; then
  # --reuse-values keeps every value skaffold set (image tags included);
  # an empty agentEngine leaves AGENT_ENGINE unset, which IS LangGraph
  # (charts/agent-controller/values.yaml "TO ROLL BACK").
  helm -n "$NS" upgrade agent-controller "$REPO_ROOT/charts/agent-controller" \
    --reuse-values --set-string agent-orchestrator.config.agentEngine= >/dev/null
  kubectl -n "$NS" rollout status deploy/agent-orchestrator --timeout=300s >/dev/null
fi
DEPLOYED_ENGINE="$(kubectl -n "$NS" get deploy agent-orchestrator \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AGENT_ENGINE")].value}')"
[[ "$DEPLOYED_ENGINE" == "temporal" ]] && DEPLOYED_ENGINE=temporal || DEPLOYED_ENGINE=langgraph
if [[ "$DEPLOYED_ENGINE" != "$ENGINE" ]]; then
  echo "✗ asked for $ENGINE but agent-orchestrator runs $DEPLOYED_ENGINE." >&2
  exit 1
fi
echo "  ✓ agent-orchestrator runs $ENGINE"

step "Restarting integration-gateway to re-read its webhook secrets..."
# bootstrap-secrets.sh regenerates GITHUB_WEBHOOK_SECRET on every run, and the
# gateway now reads EventSource secrets through the API rather than from env.
# If skaffold found nothing to roll, a gateway that cached the old value would
# 401 every signed delivery the suite sends -- indistinguishable from a
# verification bug. A restart makes "the cluster verifies with what's in the
# Secret" true by construction.
kubectl -n "$NS" rollout restart deploy/agent-controller-integration-gateway >/dev/null
kubectl -n "$NS" rollout status deploy/agent-controller-integration-gateway --timeout=300s >/dev/null
echo "  ✓ integration-gateway"

step "Checking both Helm releases installed..."
# Skaffold installs the releases in order and stops at the first failure, so a
# problem in agent-controller used to leave community-components -- the release
# that owns every Tool/Skill/Agent CR -- simply not installed. That presents to
# a test as a turn that never dispatches, not as a deploy error, and costs a
# whole run to work out. Checked here, by name, so it reads as what it is.
missing_releases=()
for release in agent-controller community-components; do
  status="$(helm -n "$NS" status "$release" -o json 2>/dev/null | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)"
  [[ "$status" == "deployed" ]] || missing_releases+=("$release (${status:-not installed})")
done
if [[ ${#missing_releases[@]} -gt 0 ]]; then
  echo "" >&2
  echo "✗ Helm releases not deployed:" >&2
  for r in "${missing_releases[@]}"; do echo "    - $r" >&2; done
  echo "" >&2
  echo "  helm -n $NS list --all" >&2
  exit 1
fi
# The catalog itself, not just the release: an installed community-components
# with zero CRs would dispatch nothing, and the suite's failure for that is a
# silent timeout rather than a missing-object error.
cr_count="$(kubectl -n "$NS" get tools,skills,agents --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$cr_count" -eq 0 ]]; then
  echo "" >&2
  echo "✗ community-components is deployed but no Tool/Skill/Agent CRs exist." >&2
  echo "  Nothing can be dispatched, so every agent turn in the suite would time out." >&2
  exit 1
fi
echo "  ✓ both releases deployed, $cr_count Tool/Skill/Agent CRs"
# Same reasoning for the event-trigger catalog (docs/adr/0048): with no
# EventSources the gateway serves no /webhooks/* route, and every webhook spec
# fails on a 404 that reads like a routing bug.
es_count="$(kubectl -n "$NS" get eventsources --no-headers 2>/dev/null | wc -l | tr -d ' ')"
et_count="$(kubectl -n "$NS" get eventtriggers --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$es_count" -eq 0 || "$et_count" -eq 0 ]]; then
  echo "" >&2
  echo "✗ found $es_count EventSource(s) and $et_count EventTrigger(s)." >&2
  echo "  The 'Applying the example EventSources/EventTriggers' step above should have created them." >&2
  exit 1
fi
echo "  ✓ $es_count EventSources, $et_count EventTriggers"

step "Waiting for the stack to be ready..."
# `helm --wait` already gates on this, but it is re-checked explicitly so a
# partially-ready cluster fails HERE with a readable pod list rather than
# inside a test's waitFor timeout, where it looks like a product bug.
kubectl -n "$NS" wait --for=condition=Available --timeout=300s \
  deploy/agent-orchestrator deploy/agent-controller-integration-gateway

echo ""
echo "✓ e2e stack is up ($ENGINE engine). Run the suite with:"
echo "    E2E_ENGINE=$ENGINE npm run e2e -w e2e"
