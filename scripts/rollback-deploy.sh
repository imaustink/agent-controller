#!/usr/bin/env bash
# rollback-deploy.sh — deploy-failure handler for the "Build, Publish &
# Deploy" workflow (.github/workflows/release.yml).
#
# Invoked as the deploy job's `if: failure()` step. When a `helm upgrade` or
# `kubectl rollout` in that job fails, this script:
#
#   1. Captures the *broken* state first (rollout status, pods, events, logs,
#      helm history) — before anything is rolled back, so the ticket has the
#      real failure evidence and not the post-rollback (healthy) picture.
#   2. Rolls each affected workload back to the previous working revision:
#        - Helm releases whose `helm upgrade` failed → `helm rollback`.
#        - Deployments whose `kubectl rollout` failed → `kubectl rollout undo`.
#   3. Opens a GitHub issue with all of the above and labels it `ai-triage`
#      (the label the integration-gateway watches to auto-start triage — see
#      docs/adr/0024-integration-route-crd-for-deterministic-event-routing.md).
#
# It talks to the GitHub REST API with `curl` rather than `gh`, so it does not
# depend on the GitHub CLI being installed on the self-hosted deploy runner.
#
# Which workload rolled back is driven by the triggering steps' outcomes,
# passed in as env vars by the workflow (see release.yml):
#   UPGRADE_AGENT_OUTCOME      outcome of "Helm upgrade agent-controller"
#   UPGRADE_COMMUNITY_OUTCOME  outcome of "Helm upgrade community-components"
#   ROLLOUT_OUTCOME            outcome of "Rollout restart"
# Each is a GitHub Actions step outcome ("success" | "failure" | ...); only
# "failure" triggers a rollback of the matching workload.
#
# The script is intentionally best-effort about diagnostics and rollback (a
# missing pod or a `kubectl` hiccup must not stop us from filing the ticket),
# but exits non-zero if it could not open the ticket — a silently-lost failure
# report is worse than a noisy one.

set -uo pipefail

# --- configuration (env-overridable, defaults match the deploy job) ----------
NAMESPACE="${NAMESPACE:-controller-agent}"
# Long-running Deployments restarted by the deploy job's "Rollout restart" step.
DEPLOYMENTS="${DEPLOYMENTS:-agent-orchestrator core-controller agent-controller-integration-gateway}"

UPGRADE_AGENT_OUTCOME="${UPGRADE_AGENT_OUTCOME:-}"
UPGRADE_COMMUNITY_OUTCOME="${UPGRADE_COMMUNITY_OUTCOME:-}"
ROLLOUT_OUTCOME="${ROLLOUT_OUTCOME:-}"

# GitHub context (all provided by Actions; guarded for local dry-runs).
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-imaustink/agent-controller}"
GITHUB_SHA="${GITHUB_SHA:-unknown}"
GITHUB_REF_NAME="${GITHUB_REF_NAME:-unknown}"
GITHUB_ACTOR="${GITHUB_ACTOR:-unknown}"
GITHUB_RUN_ID="${GITHUB_RUN_ID:-}"
GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

SHORT_SHA="${GITHUB_SHA:0:7}"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

WORKDIR="$(mktemp -d)"
BODY="${WORKDIR}/body.md"
trap 'rm -rf "${WORKDIR}"' EXIT

# --- small helpers -----------------------------------------------------------

# section <title> <command...> — run a command best-effort, appending its
# output to the ticket body inside a collapsible block. Never aborts the
# script, and caps output so one chatty command can't produce a giant issue.
MAX_LINES="${MAX_SECTION_LINES:-200}"
section() {
  local title="$1"; shift
  {
    printf '<details><summary>%s</summary>\n\n```\n' "${title}"
    if "$@" 2>&1 | tail -n "${MAX_LINES}"; then :; fi
    printf '```\n</details>\n\n'
  } >> "${BODY}"
}

log() { printf '::group::rollback-deploy: %s\n%s\n::endgroup::\n' "$1" "${2:-}"; }

# --- decide what failed and therefore what to roll back ----------------------
HELM_ROLLBACK=()
[ "${UPGRADE_AGENT_OUTCOME}" = "failure" ] && HELM_ROLLBACK+=("agent-controller")
[ "${UPGRADE_COMMUNITY_OUTCOME}" = "failure" ] && HELM_ROLLBACK+=("community-components")

DEPLOY_ROLLBACK=()
if [ "${ROLLOUT_OUTCOME}" = "failure" ]; then
  # shellcheck disable=SC2206  # word-splitting the space-separated list is intended
  DEPLOY_ROLLBACK=(${DEPLOYMENTS})
fi

FAILED_SUMMARY=()
[ "${UPGRADE_AGENT_OUTCOME}" = "failure" ] && FAILED_SUMMARY+=("\`helm upgrade agent-controller\`")
[ "${UPGRADE_COMMUNITY_OUTCOME}" = "failure" ] && FAILED_SUMMARY+=("\`helm upgrade community-components\`")
[ "${ROLLOUT_OUTCOME}" = "failure" ] && FAILED_SUMMARY+=("\`kubectl rollout restart/status\`")
[ ${#FAILED_SUMMARY[@]} -eq 0 ] && FAILED_SUMMARY+=("the deploy job (no failing step reported — investigate the run logs)")

# ==== 1. capture the broken state BEFORE rolling back ========================
: > "${BODY}"
{
  echo "## Deployment failure — automatic rollback"
  echo
  echo "The **Build, Publish & Deploy** workflow failed to roll out commit"
  echo "[\`${SHORT_SHA}\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA})"
  echo "to namespace \`${NAMESPACE}\`. CI has attempted to roll the affected"
  echo "workloads back to their previous working revision (details below)."
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| Failed | $(IFS=', '; echo "${FAILED_SUMMARY[*]}") |"
  echo "| Commit | [\`${SHORT_SHA}\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}) on \`${GITHUB_REF_NAME}\` |"
  echo "| Pushed by | @${GITHUB_ACTOR} |"
  echo "| Workflow run | [${GITHUB_RUN_ID:-n/a}](${RUN_URL}) |"
  echo "| Namespace | \`${NAMESPACE}\` |"
  echo
  echo "### Failure diagnostics (state at time of failure)"
  echo
} >> "${BODY}"

if command -v kubectl >/dev/null 2>&1; then
  for dep in ${DEPLOYMENTS}; do
    section "rollout status — ${dep}" kubectl rollout status "deploy/${dep}" -n "${NAMESPACE}" --timeout=10s
    section "describe deploy — ${dep}" kubectl describe "deploy/${dep}" -n "${NAMESPACE}"
    # Logs from the not-ready pods are usually the actual root cause
    # (CrashLoopBackOff stack trace, bad config, failed migration, ...).
    section "recent logs — ${dep}" kubectl logs "deploy/${dep}" -n "${NAMESPACE}" --all-containers --tail=100 --prefix
  done
  section "pods" kubectl get pods -n "${NAMESPACE}" -o wide
  section "recent events" kubectl get events -n "${NAMESPACE}" --sort-by=.lastTimestamp
else
  echo "> \`kubectl\` not available — skipped cluster diagnostics." >> "${BODY}"
fi

if command -v helm >/dev/null 2>&1; then
  for rel in agent-controller community-components; do
    section "helm history — ${rel}" helm history "${rel}" -n "${NAMESPACE}" --max 10
  done
fi

# ==== 2. roll back to the previous working revision ==========================
{
  echo "### Rollback actions"
  echo
} >> "${BODY}"

ROLLBACK_TROUBLE=0

for rel in "${HELM_ROLLBACK[@]:-}"; do
  [ -z "${rel}" ] && continue
  if ! command -v helm >/dev/null 2>&1; then
    echo "- ⚠️ \`helm\` not available — could not roll back release \`${rel}\`." >> "${BODY}"
    ROLLBACK_TROUBLE=1
    continue
  fi
  log "helm rollback ${rel}"
  # Revision 0 = the previous release. `--wait` blocks until the restored
  # revision's resources report ready so we don't file "rolled back" on a
  # rollback that itself never became healthy.
  if out="$(helm rollback "${rel}" 0 -n "${NAMESPACE}" --wait --timeout 5m 2>&1)"; then
    echo "- ✅ Rolled Helm release \`${rel}\` back to its previous revision." >> "${BODY}"
  else
    echo "- ❌ Failed to roll back Helm release \`${rel}\`:" >> "${BODY}"
    printf '\n  ```\n%s\n  ```\n' "${out}" >> "${BODY}"
    ROLLBACK_TROUBLE=1
  fi
done

for dep in "${DEPLOY_ROLLBACK[@]:-}"; do
  [ -z "${dep}" ] && continue
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "- ⚠️ \`kubectl\` not available — could not roll back \`${dep}\`." >> "${BODY}"
    ROLLBACK_TROUBLE=1
    continue
  fi
  log "kubectl rollout undo ${dep}"
  if out="$(kubectl rollout undo "deploy/${dep}" -n "${NAMESPACE}" 2>&1)"; then
    echo "- ✅ Rolled back \`deploy/${dep}\` (\`kubectl rollout undo\`)." >> "${BODY}"
    # Confirm the restored revision actually becomes healthy.
    if ! kubectl rollout status "deploy/${dep}" -n "${NAMESPACE}" --timeout=5m >/dev/null 2>&1; then
      echo "  - ⚠️ Previous revision of \`${dep}\` did not report ready within 5m — needs manual attention." >> "${BODY}"
      ROLLBACK_TROUBLE=1
    fi
  else
    echo "- ❌ Failed to roll back \`deploy/${dep}\`:" >> "${BODY}"
    printf '\n  ```\n%s\n  ```\n' "${out}" >> "${BODY}"
    ROLLBACK_TROUBLE=1
  fi
done

if [ ${#HELM_ROLLBACK[@]} -eq 0 ] && [ ${#DEPLOY_ROLLBACK[@]} -eq 0 ]; then
  echo "- ℹ️ No specific step reported failure, so nothing was rolled back automatically. Review the workflow run and cluster state manually." >> "${BODY}"
fi

{
  echo
  echo "> ⚠️ **Note on \`:latest\` images:** deploy images are published under the"
  echo "> mutable \`:latest\` tag, so \`kubectl rollout undo\` restores the previous"
  echo "> pod template but nodes may still pull the newly-broken \`:latest\` when"
  echo "> scaling up. Pinning images by digest/commit SHA would make workload"
  echo "> rollback fully deterministic — see the failure above to decide if that's"
  echo "> worth doing."
  echo
  echo "---"
  echo "_Filed automatically by \`scripts/rollback-deploy.sh\` from workflow run [${GITHUB_RUN_ID:-n/a}](${RUN_URL})._"
} >> "${BODY}"

# ==== 3. open the ai-triage ticket ===========================================
TITLE="Deploy failed & rolled back: ${SHORT_SHA} — $(IFS=', '; echo "${FAILED_SUMMARY[*]}" | sed 's/`//g')"

if [ -z "${GH_TOKEN}" ]; then
  log "no token" "GH_TOKEN/GITHUB_TOKEN not set — cannot open ticket. Body follows:"
  cat "${BODY}"
  exit 1
fi

PAYLOAD="${WORKDIR}/payload.json"
jq -n \
  --arg title "${TITLE}" \
  --rawfile body "${BODY}" \
  '{title: $title, body: $body, labels: ["ai-triage"]}' > "${PAYLOAD}"

HTTP_CODE="$(curl -sS -o "${WORKDIR}/resp.json" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/issues" \
  --data-binary "@${PAYLOAD}")"

if [ "${HTTP_CODE}" = "201" ]; then
  ISSUE_URL="$(jq -r '.html_url' < "${WORKDIR}/resp.json")"
  log "ticket opened" "Opened ai-triage ticket: ${ISSUE_URL}"
  echo "Opened ai-triage ticket: ${ISSUE_URL}"
  # Surface it on the job summary if available.
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && {
    echo "### 🔁 Deployment rolled back" >> "${GITHUB_STEP_SUMMARY}"
    echo "Opened ai-triage ticket: ${ISSUE_URL}" >> "${GITHUB_STEP_SUMMARY}"
  }
  # Non-zero if a rollback step had trouble, so the (already-red) job's final
  # step also flags that the rollback needs a human look.
  exit "${ROLLBACK_TROUBLE}"
else
  log "ticket failed" "GitHub API returned HTTP ${HTTP_CODE}:"
  cat "${WORKDIR}/resp.json" || true
  echo "Failed to open ai-triage ticket (HTTP ${HTTP_CODE}). Failure body:"
  cat "${BODY}"
  exit 1
fi
