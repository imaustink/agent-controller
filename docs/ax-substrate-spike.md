# Agent Sandbox / Substrate / AX spike: findings and scope

Status: **prototype landed** — `ToolRun` runs on either backend, demo included
Date: 2026-09-24
Branch: `worktree-ax-integration`

> **Run the demo:** `scripts/sandbox-backend-demo.sh` — needs kind, kubectl, go
> and docker, and nothing else. It creates its own throwaway cluster, installs
> agent-sandbox v1.0.4, and runs five acts: **1m19s from no cluster at all**,
> ~45s against a warm one. Re-runnable; `--teardown` removes the cluster. A
> captured run is in
> [demos/sandbox-backend-demo-output.txt](demos/sandbox-backend-demo-output.txt).

Question this answers: can Google's agent-runtime stack replace the execution
layer under our `ToolRun`/`AgentRun` CRDs, and retire the checkpoint-resume
machinery of [ADR 0033](adr/0033-resumable-agent-turns.md)?

Answer: **yes, at the Agent Sandbox layer. Not at the AX layer.**

## Three layers, not one

| Layer | What it is | Maturity |
| ----- | ---------- | -------- |
| [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) | Kubernetes CRDs: `Sandbox`, `SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool`. Wraps a full `corev1.PodSpec`; delegates isolation to gVisor/Kata via `RuntimeClass` | **v1beta1**, SIG Apps, vendor-neutral |
| [Agent Substrate](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate) | Takes "the core secure runtime and snapshotting capabilities of Agent Sandbox and pairs them with a minimal control plane designed to bypass some of the limitations of Kubernetes". Source of the 250-actors-on-8-pods and sub-second-resume numbers | v1alpha1, GKE-tuned, GA allowlisted |
| [`google/ax`](https://github.com/google/ax) | Opinionated agent orchestrator on Substrate | v1alpha1, breaking changes promised |

Substrate builds **on** Sandbox rather than replacing it, so targeting Sandbox
does not foreclose Substrate later.

## Recommendation: target Agent Sandbox

`Sandbox.spec.podTemplate.spec` is a full `corev1.PodSpec`. Everything
`run_job.go` builds today carries over:

| Ours | Agent Sandbox | Notes |
| ---- | ------------- | ----- |
| Job `serviceAccountName` (`run_job.go:178`) | `podTemplate.spec.serviceAccountName` | unchanged |
| `secretEnv` → `secretKeyRef` ([ADR 0032](adr/0032-tool-level-identity-delegation-and-github-cli-tool.md)) | `podTemplate.spec.containers[].env[].valueFrom.secretKeyRef` | unchanged; no plaintext |
| `timeoutSeconds` → `activeDeadlineSeconds` | `lifecycle.shutdownTime` + `shutdownPolicy` | absolute time, not duration |
| `job.Status.Succeeded` (`run_job.go:305`) | `Finished` condition, reason `PodSucceeded`/`PodFailed` | [ADR 0010](adr/0010-crd-catalog-and-tool-controller.md) semantics preserved |
| Secret GC via `ownerReferences` | real k8s object — owner refs work | unchanged |
| Hardened run contract (`docs/security.md`) | plus `RuntimeClass` gVisor/Kata | strictly stronger |

So `run_job.go` changes from building a `batchv1.Job` to building a
`v1beta1.Sandbox` around substantially the same PodSpec. Tool images are
**not** rebuilt. This applies to both `ToolRun` and `AgentRun`.

Two things we gain that Jobs cannot give us:

- `operatingMode: Suspended` terminates the Pod but retains the Sandbox object
  and its volumes, declaratively. This is the ADR 0033 path expressed as state
  rather than machinery.
- `SandboxWarmPool` + `SandboxClaim` pre-warm sandboxes, attacking one-shot
  tool cold-start latency directly.

### The honest limitation: where resume actually comes from

Three separate things, easily conflated:

| Capability | Where it lives | Availability |
| ---------- | -------------- | ------------ |
| Suspend = terminate Pod, keep CR + volumes | core Sandbox, `spec.operatingMode` | portable, v1beta1 |
| Checkpoint live memory + rootfs, wake mid-process | **GKE Pod Snapshots** (`podsnapshot.gke.io/v1`) | **GKE only** |
| Driving the above at density with sub-second wake | Agent Substrate's control plane | GKE-tuned, alpha |

[KEP-694](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/keps/694-kep-for-suspend-and-resume-for-beta/README.md)
states the beta goal plainly: a clean suspend/resume API, and "This does not
include the Snapshot API." Core suspend has no memory state — a resume is a
cold boot onto the same volumes.

Substrate does **not** add memory resume to Sandbox. Per Google's announcement
it *takes* "the core secure runtime and snapshotting capabilities of Agent
Sandbox and pairs them with a minimal control plane" — it consumes that
machinery. Its contribution is bypassing the Kubernetes API server on the hot
path, which is what the density and latency numbers measure.

**Consequence for us:** the "resume mid-thought" behavior needs GKE Standard
≥ 1.35.3, a gVisor node pool on a non-E2 machine series, and a GCS bucket with
hierarchical namespace. On k3s we get pod-termination suspend and nothing more,
regardless of which of the three layers we adopt. Note also that snapshot
*creation* is slow — the GKE runbook waits on it with `--timeout=600s`. The
sub-second figure describes the wake, not the checkpoint.

So the ADR 0033 question splits in two: Sandbox gives us suspend/resume as
declarative state instead of bespoke machinery, which is worth having on its
own. Eliminating rehydration entirely is a GKE-only capability we cannot reach
from the homelab target.

## Why not AX

Recorded so we do not revisit it.

AX is not CRDs. It is a separate gRPC control plane (`ax-server` +
`ax-controller`) with its own Redis store and `metadata.atespace` instead of
`namespace`. No informers, no `ownerReferences`, no `kubectl get task`.
`TaskSpec` field 8 (`gateway`) and field 9 (`policies`) are both `reserved` —
removed. The entire spec is `suspend`, `image`, `command`, `env`, `resources`,
`workspaces`, `debug`.

Three disqualifiers:

1. **No exit status.** `docs/runner.md`: *"The control plane does not currently
   read the command's exit status back from the container."* Phases are
   Running / Suspended / Failed / Terminating — no Succeeded. ADR 0010 made the
   Job-mirrored phase the source of truth *over* the callback payload; AX
   inverts that. No deadline field either.
2. **Secrets are plaintext.** `EnvVar` is `{name, value}` strings persisted in
   AX's Redis. `ToolRunSpec.SecretKeySelector` says "Never carry the secret
   value itself in the spec," and [ADR 0034](adr/0034-durable-credential-store.md)
   exists because credentials in an ephemeral store cost us an outage. No
   service account field at all.
3. **Every tool image rebuilt.** The container is always launched as
   `/usr/local/bin/ax-task-runner`, which must serve HTTP on port 80
   (`/healthz`, `/readyz`, metadata), prepare workspaces idempotently,
   supervise the command, stay running after it exits, and drain on `SIGTERM`.
   Our tools are one-shot CLIs that exit with a status.

AX's `Workspace` (git + MCP + skills) is the one genuinely nice idea, and it
duplicates what our catalog already does better.

## What the prototype does

Implemented on this branch, against agent-sandbox **v1.0.4** on kind:

| File | What it adds |
| ---- | ------------ |
| `internal/sandboxapi/types.go` | Minimal mirror of `agents.x-k8s.io/v1beta1` Sandbox (see the package doc for why it is a mirror rather than the real dependency) |
| `internal/controller/run_sandbox.go` | `buildRunSandbox`, `sandboxPhase`, and the backend resolver |
| `internal/controller/run_job.go` | `buildRunPodSpec` extracted so both backends build the *same* pod |
| `internal/controller/toolrun_controller.go` | `createWorkload` dispatches on backend; `syncSandboxStatus` mirrors conditions |
| `api/v1alpha1/toolrun_types.go` | `status.executionBackend`, recorded at creation |
| `scripts/sandbox-backend-demo.sh` | The five-act demo |

Selecting a backend, most specific first: a
`core.controller-agent.dev/execution-backend` annotation on the ToolRun, then
the same annotation on the Tool, then `AGENT_EXECUTION_BACKEND`. **Anything
unrecognised means Job**, so a typo cannot silently move production onto the
experimental path. Nothing changes for existing runs: the default is Job, and
`make test` passes unmodified.

### What the demo establishes

1. A ToolRun on the Job backend reaches `Succeeded` — unchanged.
2. The same ToolRun on the Sandbox backend reaches `Succeeded`, with the
   terminal phase read from the Sandbox's `Finished=True/PodSucceeded`
   condition. ADR 0010's rule survives intact.
3. The two backends produce a byte-identical pod: same service account,
   uid/gid 10001, `RuntimeDefault` seccomp, read-only root fs, drop-ALL,
   and the same `secretKeyRef`-resolved credential env. Asserted in the
   cluster by the demo and in CI by `TestBackendsProduceIdenticalPodSpec`.
4. A running Sandbox-backed run suspends (`operatingMode: Suspended`, pod
   terminated, Sandbox object retained) and resumes — **2 seconds** on kind —
   without the ToolRun ever going terminal.
5. Deleting the ToolRun garbage-collects the Sandbox through `ownerReferences`,
   exactly as it does a Job.

### Two bugs found while building it

Both are recorded because neither is visible from the API docs, and the second
would have taken production down.

**1. Registering the Sandbox watch unconditionally breaks every cluster that
has not installed agent-sandbox.** controller-runtime does not resolve an owned
type's informer lazily — it starts the watch at manager startup and, for a kind
with no CRD, retries discovery forever while the controller blocks waiting for
that cache to sync. The ToolRun controller never started its workers at all.
Verified directly against a kind cluster carrying our CRDs and no
agent-sandbox; `make test` does not catch it, because envtest never calls
`SetupWithManager`.

`SetupWithManager` now probes the RESTMapper and registers `Owns(&Sandbox{})`
only when the API is served, logging a one-line notice otherwise. A run that
asks for the Sandbox backend on such a cluster fails immediately with
`ExecutionBackendUnavailable` and a message naming the missing CRDs, rather
than requeueing forever. The trade-off: installing agent-sandbox into a running
cluster needs a controller restart before the backend can be used.

**2. A suspension looks like a failure.** Suspending a
Sandbox terminates its pod, and for a moment that pod is a *failed* pod:
upstream publishes a transient `Finished=True/PodFailed` while the termination
settles, then drops the condition once suspension completes. Reading conditions
before intent therefore latched a suspended run to `Failed` — terminal, so the
reconciler stopped watching it and the later resume had nothing tracking it.

`sandboxPhase` now consults `spec.operatingMode` ahead of every condition,
since it is desired state: set before teardown begins, cleared on resume, and
therefore the only signal that does not race the pod's death.
`TestSuspensionIsNotAFailure` pins it.

Anything built on Sandbox suspend/resume — which is the whole point of adopting
it for parked turns — has to get this ordering right.

## What is left

1. **`RuntimeClass` on the k3s target.** Untested; kind runs stock runc, so the
   demo proves the control flow, not the isolation upgrade. This is still the
   load-bearing unknown for the homelab.
2. **`AgentRun`.** Only `ToolRun` has the backend switch. AgentRun is the case
   that actually wants suspend/resume (ADR 0033), and it is a larger change
   because of the NATS bridge in `engines/temporal/internal/agentrun`.
3. **`SandboxWarmPool`** for tool cold-start latency — untouched, and the one
   capability with no Job equivalent at all.
4. **The real dependency.** `internal/sandboxapi` should become
   `sigs.k8s.io/agent-sandbox/api/v1beta1` once we are ready to take k8s v0.37
   and controller-runtime v0.25 deliberately.
5. **A suspension policy.** Nothing decides *when* to suspend a parked turn.
   Note that `shutdownTime` keeps running while suspended, so a long park still
   expires the run — correct, matching a Job deadline, but it means park
   duration and tool timeout are now coupled.

Substrate is a later question, reopened only if Sandbox's suspend proves too
coarse for parked turns — and per the section above, on k3s it is the only
suspend available regardless.

## What this does not change

Temporal stays. Sandbox suspends a Pod; Temporal gives deterministic replay,
signals, retries, and the conversation workflow as a durable object.
[ADR 0036](adr/0036-temporal-execution-engine.md) is unaffected.

The identity model stays. Nothing in this stack resolves *whose* credential a
workload runs with, so every ADR from 0029 through 0042 remains ours.
