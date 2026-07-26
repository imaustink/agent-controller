#!/usr/bin/env bash
# provision-sender-assertion-secret.sh — close the unsigned-sender-login gap on a
# live deployment (docs/adr/0030 §6).
#
# Usage:  ./scripts/provision-sender-assertion-secret.sh [namespace]
#
# ## What it fixes
#
# integration-gateway authenticates to agent-orchestrator's /invoke with its own
# service token, so that token says "the gateway is calling" and nothing about
# the human who applied the label. The sender login therefore travels separately.
# With no shared secret configured, it travels in the request BODY, unsigned --
# and that field selects the caller's principal, hence which stored Claude
# credentials the run receives (docs/adr/0031). Anything holding the gateway's
# /invoke token can name a login and be handed that person's credentials. Both
# processes log a startup WARNING while it is unset.
#
# Setting one shared secret on both sides makes the orchestrator require a
# signed assertion and ignore the body field entirely.
#
# ## Why the gateway is patched first
#
# The two are only meaningful together, and the intermediate states are not
# symmetric:
#
#   gateway set, orchestrator unset  -> gateway signs, orchestrator ignores the
#                                       header and keeps trusting the body field.
#                                       Harmless: exactly today's behaviour.
#   gateway unset, orchestrator set  -> orchestrator requires a signature nobody
#                                       is producing, so every webhook turn loses
#                                       its sender login, falls back to the shared
#                                       service subject, and re-prompts for auth.
#
# So: gateway first, orchestrator second. Both are patched here before either
# rolls, which keeps that window to the rollout itself.
#
# Idempotent: re-running rotates the secret (both sides at once, so they never
# disagree). Existing keys in both Secrets are left untouched -- this PATCHES,
# it never recreates.

set -euo pipefail

NS="${1:-controller-agent}"
ORCH_SECRET="agent-orchestrator-secrets"
GW_SECRET="integration-gateway-secrets"
ORCH_DEPLOY="agent-orchestrator"
GW_DEPLOY="agent-controller-integration-gateway"

CTX="$(kubectl config current-context 2>/dev/null || true)"
echo "Context:   ${CTX:-<none>}"
echo "Namespace: $NS"
echo ""
read -r -p "Patch the sender-assertion secret into both Secrets and roll both deployments? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }

for s in "$GW_SECRET" "$ORCH_SECRET"; do
  kubectl -n "$NS" get secret "$s" >/dev/null 2>&1 || {
    echo "✗ Secret $s not found in $NS. Nothing patched." >&2
    echo "  These Secrets are hand-created -- see charts/agent-controller/values-production.yaml." >&2
    exit 1
  }
done

# ONE value, generated once, written to both. Generating per-secret is the
# failure this whole script exists to avoid: the gateway would sign with one key
# and the orchestrator verify with another, which presents as "the sender login
# vanished" (every webhook turn re-prompts) rather than as a signature error.
SECRET="$(openssl rand -hex 32)"

kubectl -n "$NS" patch secret "$GW_SECRET" \
  -p "{\"stringData\":{\"GATEWAY_SENDER_ASSERTION_SECRET\":\"$SECRET\"}}" >/dev/null
echo "  ✓ $GW_SECRET"
kubectl -n "$NS" patch secret "$ORCH_SECRET" \
  -p "{\"stringData\":{\"AGENT_SENDER_ASSERTION_SECRET\":\"$SECRET\"}}" >/dev/null
echo "  ✓ $ORCH_SECRET"
unset SECRET

# Compare what actually landed, by digest, so a typo/encoding slip is caught
# here rather than as re-prompting webhook turns later. Never prints the value.
gw_digest="$(kubectl -n "$NS" get secret "$GW_SECRET" -o jsonpath='{.data.GATEWAY_SENDER_ASSERTION_SECRET}' | shasum | cut -c1-12)"
orch_digest="$(kubectl -n "$NS" get secret "$ORCH_SECRET" -o jsonpath='{.data.AGENT_SENDER_ASSERTION_SECRET}' | shasum | cut -c1-12)"
if [[ "$gw_digest" != "$orch_digest" ]]; then
  echo "✗ The two Secrets hold DIFFERENT values ($gw_digest vs $orch_digest). Not rolling anything." >&2
  echo "  Fix the Secrets first: rolling now would break every webhook turn's sender login." >&2
  exit 1
fi
echo "  ✓ both sides match (digest $gw_digest)"

# The env vars are `secretKeyRef` with `optional: true`, so a running pod does
# not pick up a newly-added key -- it has to restart.
echo ""
echo "Rolling $GW_DEPLOY (starts signing; orchestrator still accepts the body field)..."
kubectl -n "$NS" rollout restart "deployment/$GW_DEPLOY"
kubectl -n "$NS" rollout status "deployment/$GW_DEPLOY" --timeout=180s

echo ""
echo "Rolling $ORCH_DEPLOY (starts REQUIRING the signature)..."
kubectl -n "$NS" rollout restart "deployment/$ORCH_DEPLOY"
kubectl -n "$NS" rollout status "deployment/$ORCH_DEPLOY" --timeout=300s

echo ""
echo "Verifying the startup warnings are gone..."
if kubectl -n "$NS" logs "deployment/$ORCH_DEPLOY" -c agent-orchestrator --since=5m 2>/dev/null \
    | grep -q "AGENT_SENDER_ASSERTION_SECRET is not set"; then
  echo "  ✗ agent-orchestrator still reports the secret as unset" >&2
  exit 1
fi
echo "  ✓ agent-orchestrator no longer warns"
if kubectl -n "$NS" logs "deployment/$GW_DEPLOY" --since=5m 2>/dev/null \
    | grep -q "GATEWAY_SENDER_ASSERTION_SECRET is not set"; then
  echo "  ✗ integration-gateway still reports the secret as unset" >&2
  exit 1
fi
echo "  ✓ integration-gateway no longer warns"

cat <<EOF

Done. Next webhook turn should log an [authorization] line whose principal is
github:<the sender's login> -- now from a verified assertion rather than an
unsigned body field. Watch it with:

  kubectl -n $NS logs deployment/$ORCH_DEPLOY -c agent-orchestrator -f | grep authorization
EOF
