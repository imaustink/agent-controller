#!/usr/bin/env bash
# bootstrap-secrets.sh — create the throwaway secrets the e2e stack needs on
# minikube, and report (without creating) the one that needs a real human key.
#
# Usage:  ./e2e/scripts/bootstrap-secrets.sh
#
# Every value generated here is disposable and scoped to the local minikube
# profile. Re-running regenerates them, which is fine: the stack reads them at
# pod start, so a `helm upgrade`/rollout picks up new values.
#
# The deliberate exception is OPENAI_API_KEY. The orchestrator's planner makes
# real model calls, so no generated value works — and copying it out of a live
# cluster to get one would be exfiltrating a production credential into a dev
# environment. This script refuses to do that and tells you the command to run
# yourself instead.

set -euo pipefail

NS="controller-agent"
CTX="minikube"

# Same guard as the test suite (e2e/support/guard.ts), for the same reason:
# this script CREATES cluster objects, and the default context on this machine
# is a live cluster.
CURRENT="$(kubectl config current-context 2>/dev/null || true)"
if [[ "$CURRENT" != "$CTX" ]]; then
  echo "✗ kubectl context is '$CURRENT', not '$CTX'. Refusing to create secrets." >&2
  echo "  Switch with:  kubectl config use-context $CTX" >&2
  exit 1
fi

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"

# `create --dry-run | apply` so re-running updates in place instead of
# erroring on AlreadyExists.
upsert() {
  local name="$1"; shift
  kubectl -n "$NS" create secret generic "$name" "$@" --dry-run=client -o yaml | kubectl -n "$NS" apply -f - >/dev/null
  echo "  ✓ $name"
}

rand() { openssl rand -hex 32; }
# Fixed, not random: this exact value must appear on BOTH sides of the
# orchestrator<->gateway identity-link channel (the gateway's
# GATEWAY_IDENTITY_LINK_TOKEN and the orchestrator's
# IDENTITY_LINK_GATEWAY_TOKEN). Generating it independently per secret would
# leave every /identity-link call 401ing, which surfaces as "no credential
# flow ever starts" rather than as an auth error.
IDENTITY_LINK_TOKEN="e2e-identity-link-token"
# Also fixed, and for the same reason: the gateway SIGNS the sender assertion
# with this and the orchestrator VERIFIES with it (docs/adr/0030 §6). Two
# independently-generated values would make every assertion fail verification,
# which presents as "the sender login vanished" rather than as a signature
# error.
SENDER_ASSERTION_SECRET="e2e-sender-assertion-secret"
# IDENTITY_LINK_ENCRYPTION_KEY must decode to EXACTLY 32 bytes for AES-256-GCM
# (decodeEncryptionKey throws at startup otherwise, which surfaces as a
# crashlooping gateway rather than an obvious config error).
key32() { openssl rand -base64 32; }

echo "Creating throwaway e2e secrets in $NS (context: $CTX)..."

# Prerequisites dev-up.sh hard-fails without. Only the orchestrator one is on
# the triage path the specs exercise; the other three are dummies purely to
# satisfy that check.
upsert recipe-publisher-secrets --from-literal=MEALIE_API_TOKEN="e2e-not-a-real-token"
upsert agent-controller-openwebui-google-oauth --from-literal=client-secret="e2e-not-a-real-secret"
upsert searxng-secrets --from-literal=secret-key="$(rand)"

# The gateway's own secret, referenced by values-e2e.yaml via
# `secrets.existingSecret`. The name deliberately avoids the chart's own
# generated name (agent-controller-integration-gateway): Helm refuses to adopt
# an object it doesn't own, so colliding there fails the whole release. GATEWAY_ORCHESTRATOR_TOKEN must equal the token in that file's
# agent-orchestrator staticIdentities map, or every relayed /invoke 401s.
upsert e2e-integration-gateway-secrets \
  --from-literal=GITHUB_WEBHOOK_SECRET="$(rand)" \
  --from-literal=GATEWAY_ORCHESTRATOR_TOKEN="e2e-gateway-token" \
  --from-literal=GATEWAY_IDENTITY_LINK_TOKEN="$IDENTITY_LINK_TOKEN" \
  --from-literal=IDENTITY_LINK_ENCRYPTION_KEY="$(key32)" \
  --from-literal=IDENTITY_LINK_STATE_SECRET="$(rand)" \
  --from-literal=GITHUB_APP_CLIENT_SECRET="e2e-not-a-real-secret" \
  --from-literal=GATEWAY_SENDER_ASSERTION_SECRET="$SENDER_ASSERTION_SECRET" \
  --from-literal=GITHUB_TOKEN="e2e-not-a-real-token"

# claude-code-swe-agent's static secret. The GITHUB_APP_* values are
# placeholders: no e2e run mints a real installation token.
upsert claude-code-swe-secrets \
  --from-literal=GITHUB_TOKEN="e2e-not-a-real-token" \
  --from-literal=GITHUB_APP_ID="0" \
  --from-literal=GITHUB_APP_INSTALLATION_ID="0" \
  --from-literal=GITHUB_APP_PRIVATE_KEY="e2e-not-a-real-key"

echo ""
if kubectl -n "$NS" get secret agent-orchestrator-secrets >/dev/null 2>&1; then
  # PATCH, not replace: this secret holds a real OPENAI_API_KEY that this
  # script must never overwrite. Only the identity-link token is added.
  kubectl -n "$NS" patch secret agent-orchestrator-secrets \
    -p "{\"stringData\":{\"IDENTITY_LINK_GATEWAY_TOKEN\":\"$IDENTITY_LINK_TOKEN\",\"AGENT_SENDER_ASSERTION_SECRET\":\"$SENDER_ASSERTION_SECRET\"}}" >/dev/null
  echo "  ✓ agent-orchestrator-secrets exists (OPENAI_API_KEY untouched; added IDENTITY_LINK_GATEWAY_TOKEN)"
else
  cat >&2 <<EOF
✗ agent-orchestrator-secrets is MISSING and this script will not create it.

  It needs a REAL OPENAI_API_KEY -- the orchestrator's planner/selector makes
  actual model calls, so no generated value will work. Create it yourself:

    kubectl -n $NS create secret generic agent-orchestrator-secrets \\
      --from-literal=OPENAI_API_KEY=<your-key> \\
      --from-literal=AGENT_CALLBACK_SECRET="\$(openssl rand -hex 32)"

EOF
  exit 1
fi

echo ""
echo "Done. Next:"
echo "  skaffold run"
echo "  helm upgrade --install agent-controller charts/agent-controller \\"
echo "    -f charts/agent-controller/values-minikube-demo.yaml \\"
echo "    -f charts/agent-controller/values-e2e.yaml"
echo "  npm run e2e -w e2e"
