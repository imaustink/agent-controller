#!/usr/bin/env bash
#
# sandbox-backend-demo.sh — end-to-end demo of the Sandbox execution backend.
#
# Runs the SAME ToolRun CR on both execution backends against a throwaway kind
# cluster and shows, with live cluster output rather than assertions:
#
#   Act 1  A ToolRun on the Job backend reaches Succeeded.           (unchanged)
#   Act 2  The same ToolRun on the Sandbox backend reaches Succeeded. (new path)
#   Act 3  Both backends produced a byte-identical hardened pod spec.
#   Act 4  A Sandbox-backed run suspends and resumes without the ToolRun going
#          terminal. NOTE: a Job can suspend too (spec.suspend, which likewise
#          deletes active pods and recreates them on resume). What differs is
#          that the Sandbox keeps its name, hostname and volumes across the
#          cycle, where a resumed Job gets a brand-new pod.
#   Act 5  Deleting the ToolRun garbage-collects its Sandbox via ownerReferences.
#
# Usage:
#   scripts/sandbox-backend-demo.sh              # full run, leaves the cluster up
#   scripts/sandbox-backend-demo.sh --teardown   # delete the kind cluster and exit
#
# Requires: kind, kubectl, go, docker.

set -euo pipefail

CLUSTER=ax-sandbox-demo
CTX="kind-${CLUSTER}"
NS=controller-agent
SANDBOX_VERSION=v1.0.4
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROLLER_DIR="${REPO_ROOT}/controllers/core-controller"
LOG=/tmp/${CLUSTER}-controller.log
CONTROLLER_PID=""

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
act()  { printf '\n\033[1;36m━━━ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

k() { kubectl --context "$CTX" "$@"; }
kn() { kubectl --context "$CTX" -n "$NS" "$@"; }

cleanup() {
  if [[ -n "$CONTROLLER_PID" ]] && kill -0 "$CONTROLLER_PID" 2>/dev/null; then
    kill "$CONTROLLER_PID" 2>/dev/null || true
    wait "$CONTROLLER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--teardown" ]]; then
  kind delete cluster --name "$CLUSTER"
  exit 0
fi

# ---------------------------------------------------------------- setup ----

act "Setup"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  info "reusing kind cluster ${CLUSTER}"
else
  info "creating kind cluster ${CLUSTER}"
  kind create cluster --name "$CLUSTER" --wait 120s >/dev/null
fi
ok "cluster ready"

info "installing agent-sandbox ${SANDBOX_VERSION} (kubernetes-sigs)"
k apply --server-side -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${SANDBOX_VERSION}/sandbox.yaml" >/dev/null
k -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=300s >/dev/null
ok "agent-sandbox controller running ($(k get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[*].name}'))"

info "installing core-controller CRDs"
k apply -f "${CONTROLLER_DIR}/config/crd/bases/" >/dev/null
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
kn create secret generic callback-hmac \
  --from-literal=secret=demo-not-a-real-secret \
  --dry-run=client -o yaml | kn apply -f - >/dev/null
ok "CRDs + namespace + callback secret in place"

info "building core-controller"
# Built and exec'd directly rather than via `go run`: `go run` forks a child
# for the compiled binary, so the PID this script holds is the wrapper, and
# killing it on exit orphans the manager — which then keeps its bind address
# and breaks the next run.
( cd "$CONTROLLER_DIR" && go build -o bin/manager ./cmd/main.go )

info "starting core-controller against the cluster (log: ${LOG})"
"${CONTROLLER_DIR}/bin/manager" \
  --metrics-bind-address=0 --health-probe-bind-address=0 >"$LOG" 2>&1 &
CONTROLLER_PID=$!

for _ in $(seq 1 60); do
  if grep -q '"controller": "toolrun"' "$LOG" 2>/dev/null; then break; fi
  sleep 2
done
grep -q '"controller": "toolrun"' "$LOG" || die "controller did not start; see $LOG"
ok "core-controller reconciling (pid ${CONTROLLER_PID})"

# --------------------------------------------------------------- fixtures --

kn apply -f - >/dev/null <<'YAML'
apiVersion: core.controller-agent.dev/v1alpha1
kind: Tool
metadata:
  name: echo-tool
  namespace: controller-agent
spec:
  description: "Prints a line and exits - stands in for a real one-shot tool container."
  input: "a message"
  output: "the message on stdout"
  allowedRoles: ["demo"]
  image: busybox:1.36
  serviceAccountName: default
  args: ["sh", "-c", "echo '[tool] running'; sleep 3; echo '[tool] done'"]
  resources:
    requests: {cpu: "50m", memory: "32Mi"}
    limits: {cpu: "200m", memory: "128Mi"}
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: Tool
metadata:
  name: slow-tool
  namespace: controller-agent
spec:
  description: "Runs long enough to be suspended mid-flight."
  input: "none"
  output: "none"
  allowedRoles: ["demo"]
  image: busybox:1.36
  serviceAccountName: default
  args: ["sh", "-c", "i=0; while [ $i -lt 600 ]; do echo \"[tool] tick $i\"; i=$((i+1)); sleep 1; done"]
  resources:
    requests: {cpu: "50m", memory: "32Mi"}
    limits: {cpu: "200m", memory: "128Mi"}
YAML

# Fresh runs each invocation, so the demo is repeatable.
kn delete toolrun on-job on-sandbox parked --ignore-not-found --wait=true >/dev/null 2>&1 || true

run_manifest() { # $1=name  $2=toolRef  $3=extra annotations block
  cat <<YAML
apiVersion: core.controller-agent.dev/v1alpha1
kind: ToolRun
metadata:
  name: $1
  namespace: ${NS}
${3}
spec:
  toolRef: $2
  timeoutSeconds: 900
  callback:
    url: http://agent-orchestrator-callback.${NS}.svc.cluster.local:8080
    secretRef:
      name: callback-hmac
      key: secret
YAML
}

SANDBOX_ANN='  annotations:
    core.controller-agent.dev/execution-backend: sandbox'

wait_phase() { # $1=toolrun  $2=phase  $3=timeout seconds
  local deadline=$(( SECONDS + $3 )) got
  while (( SECONDS < deadline )); do
    got=$(kn get toolrun "$1" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$got" == "$2" ]] && return 0
    sleep 2
  done
  echo "    last observed phase: ${got:-<none>}" >&2
  return 1
}

# ------------------------------------------------------------------ act 1 --

act "Act 1 — the unchanged path: ToolRun on the Job backend"

run_manifest on-job echo-tool "" | kn apply -f - >/dev/null
wait_phase on-job Succeeded 180 || die "on-job never reached Succeeded"
kn get toolrun on-job
ok "Job backend reached Succeeded (status.executionBackend=job)"

# ------------------------------------------------------------------ act 2 --

act "Act 2 — the same ToolRun on the Sandbox backend"

run_manifest on-sandbox echo-tool "$SANDBOX_ANN" | kn apply -f - >/dev/null
wait_phase on-sandbox Succeeded 180 || die "on-sandbox never reached Succeeded"
kn get toolrun on-sandbox
echo
info "the workload it created is not a Job:"
kn get sandbox toolrun-on-sandbox
echo
info "its terminal phase came from the Sandbox's Finished condition:"
kn get sandbox toolrun-on-sandbox \
  -o jsonpath='{range .status.conditions[*]}    {.type}={.status} reason={.reason}{"\n"}{end}'
ok "Sandbox backend reached Succeeded through the same ToolRun contract"

# ------------------------------------------------------------------ act 3 --

act "Act 3 — both backends produced the same hardened pod"

JOB_POD=$(kn get pods -l core.controller-agent.dev/toolrun=on-job -o jsonpath='{.items[0].metadata.name}')
SB_POD=toolrun-on-sandbox

FIELDS='{.spec.serviceAccountName}{"\n"}{.spec.securityContext.runAsUser}{"\n"}{.spec.securityContext.runAsGroup}{"\n"}{.spec.securityContext.runAsNonRoot}{"\n"}{.spec.securityContext.seccompProfile.type}{"\n"}{.spec.restartPolicy}{"\n"}{.spec.containers[0].image}{"\n"}{.spec.containers[0].args}{"\n"}{.spec.containers[0].securityContext.readOnlyRootFilesystem}{"\n"}{.spec.containers[0].securityContext.allowPrivilegeEscalation}{"\n"}{.spec.containers[0].securityContext.capabilities.drop}{"\n"}{range .spec.containers[0].env[*]}{.name}={.value}{.valueFrom.secretKeyRef.name}/{.valueFrom.secretKeyRef.key}{"\n"}{end}'

kn get pod "$JOB_POD" -o jsonpath="$FIELDS" > /tmp/${CLUSTER}-job-pod.txt
kn get pod "$SB_POD"  -o jsonpath="$FIELDS" > /tmp/${CLUSTER}-sandbox-pod.txt

if diff -u /tmp/${CLUSTER}-job-pod.txt /tmp/${CLUSTER}-sandbox-pod.txt > /tmp/${CLUSTER}-pod-diff.txt; then
  ok "security context, image, args, and env are identical across backends"
  echo
  sed 's/^/    /' /tmp/${CLUSTER}-job-pod.txt
else
  echo
  cat /tmp/${CLUSTER}-pod-diff.txt
  die "pod specs diverged between backends"
fi

echo
info "note the credential wiring: RECIPE_CALLBACK_SECRET resolves through a"
info "secretKeyRef, never a literal value — the property AX's TaskSpec cannot express."

# ------------------------------------------------------------------ act 4 --

act "Act 4 — suspend and resume, keeping identity"

run_manifest parked slow-tool "$SANDBOX_ANN" | kn apply -f - >/dev/null
wait_phase parked Running 180 || die "parked never reached Running"
ok "run is Running; pod is up"
kn get pod toolrun-parked --no-headers 2>/dev/null | sed 's/^/    /' || true

info "suspending: kubectl patch sandbox toolrun-parked --type=merge -p '{\"spec\":{\"operatingMode\":\"Suspended\"}}'"
kn patch sandbox toolrun-parked --type=merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null

SUSPEND_DEADLINE=$(( SECONDS + 120 ))
while (( SECONDS < SUSPEND_DEADLINE )); do
  if ! kn get pod toolrun-parked >/dev/null 2>&1; then break; fi
  sleep 2
done
kn get pod toolrun-parked >/dev/null 2>&1 && die "pod still present after suspend"
ok "backing pod terminated"

echo
info "the Sandbox object survived, and reports why:"
kn get sandbox toolrun-parked \
  -o jsonpath='{range .status.conditions[*]}    {.type}={.status} reason={.reason}{"\n"}{end}'
echo
info "and the ToolRun did NOT go terminal — a suspended run has not finished:"
kn get toolrun parked
PHASE=$(kn get toolrun parked -o jsonpath='{.status.phase}')
[[ "$PHASE" == "Running" ]] || die "expected parked to stay Running while suspended, got ${PHASE}"
ok "ToolRun stayed Running across the suspension"

info "resuming: operatingMode=Running"
RESUME_START=$(date +%s)
kn patch sandbox toolrun-parked --type=merge -p '{"spec":{"operatingMode":"Running"}}' >/dev/null

RESUME_DEADLINE=$(( SECONDS + 180 ))
while (( SECONDS < RESUME_DEADLINE )); do
  if [[ "$(kn get pod toolrun-parked -o jsonpath='{.status.phase}' 2>/dev/null)" == "Running" ]]; then break; fi
  sleep 1
done
[[ "$(kn get pod toolrun-parked -o jsonpath='{.status.phase}' 2>/dev/null)" == "Running" ]] \
  || die "pod did not come back after resume"
RESUME_SECS=$(( $(date +%s) - RESUME_START ))
ok "pod back in ${RESUME_SECS}s, same Sandbox name and identity"
kn get pod toolrun-parked --no-headers | sed 's/^/    /'

echo
info "IMPORTANT: this is a cold restart onto retained volumes, not a memory"
info "snapshot. The container restarted its work from the beginning:"
kn logs toolrun-parked --tail=3 2>/dev/null | sed 's/^/    /' || true
info "Mid-process resume needs GKE Pod Snapshots, which are not available here."

# ------------------------------------------------------------------ act 5 --

act "Act 5 — ownerReferences still garbage-collect the workload"

kn get sandbox toolrun-parked -o jsonpath='    owner: {.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
kn delete toolrun parked --wait=true >/dev/null

GC_DEADLINE=$(( SECONDS + 120 ))
while (( SECONDS < GC_DEADLINE )); do
  if ! kn get sandbox toolrun-parked >/dev/null 2>&1; then break; fi
  sleep 2
done
kn get sandbox toolrun-parked >/dev/null 2>&1 && die "Sandbox survived its owner"
ok "deleting the ToolRun reclaimed its Sandbox — same lifecycle as a Job"

# ---------------------------------------------------------------- summary --

act "Summary"
kn get toolruns
echo
bold "  What this proves"
echo "    • The ToolRun CRD is unchanged as a public API; only the workload kind differs."
echo "    • ADR 0010's rule holds: the workload's own status, not the callback, decides"
echo "      the terminal phase — via the Sandbox Finished condition."
echo "    • docs/security.md's hardened contract is byte-identical across backends."
echo "    • Credentials stay secretKeyRef-resolved; nothing is written in plaintext."
echo "    • Suspend/resume is declarative state, and the pod keeps its name and"
echo "      hostname across the cycle. (A Job can suspend too — spec.suspend — but"
echo "      a resumed Job gets a brand-new pod with a new random name.)"
echo "    • ownerReferences GC is preserved."
echo
bold "  What this does NOT prove"
echo "    • Resume is a cold restart on retained volumes. Mid-process wake needs GKE"
echo "      Pod Snapshots (GKE Standard ≥1.35.3, gVisor node pool, GCS bucket)."
echo "    • Nothing about isolation. Neither backend sets runtimeClassName, and kind"
echo "      runs stock runc. Note that runtimeClassName is a plain PodSpec field, so"
echo "      gVisor is available on the Job path too — it is not a reason to adopt this."
echo "    • AgentRun still runs on Jobs; only ToolRun has the backend switch."
echo
info "cluster left running — rerun this script to repeat, or --teardown to remove it"
