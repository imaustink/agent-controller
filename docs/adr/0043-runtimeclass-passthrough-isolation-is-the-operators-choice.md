# 0043. `runtimeClassName` passthrough: isolation is the operator's choice

Date: 2026-09-25

## Status

Accepted

## Context

Investigating whether [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
should replace the Job execution layer (`docs/ax-substrate-spike.md`) turned up
a claim worth separating from that question entirely: that adopting it would
bring stronger isolation for tool containers, via gVisor or Kata.

It would not, because that isolation was never agent-sandbox's to give.
`runtimeClassName` is a field on `corev1.PodSpec`. A `batch/v1` Job's pod can
select a sandboxed runtime exactly as well as a `Sandbox`'s pod can. Upstream
takes the same position: KEP-539.2 lists "mandating a specific isolation
technology (e.g. gVisor vs Firecracker)" as an explicit non-goal, and the
agent-sandbox docs describe the controller as delegating isolation to runtimes
configured "via `RuntimeClass`" rather than providing any itself.

So isolation is orthogonal to the execution backend, and we had no way to
express it at all: nothing in `ToolSpec` or `AgentSpec` reached
`PodSpec.RuntimeClassName`, so every run used the cluster's default runtime
whatever the operator had installed.

Surveying where our workloads actually run made it clear this should not be a
decision the controller makes:

| Environment | What it is | What isolation is available |
| ----------- | ---------- | --------------------------- |
| Homelab (`default`) | k3s v1.31 on 8 arm64 Raspberry Pis | runc today. gVisor needs `runsc` per node, a `config.toml.tmpl` handler, and a kernel built with `CONFIG_ARM64_VA_BITS_48` — the Pi kernel family commonly ships 39-bit, which gVisor cannot run in |
| [ferry](https://github.com/imaustink/ferry) | Kubernetes on Apple Silicon; in mode 1 a pod **is** a VM with its own kernel | Already a hardware-virtualization boundary, stronger than gVisor. Adding a sandboxed runtime would nest a weaker boundary inside a stronger one |
| Managed clusters (EKS, GKE) | vendor-managed nodes | Whatever the vendor supports — GKE Sandbox, a custom AMI, or nothing |

Three environments, three different right answers, and in one of them the
right answer is "nothing, the platform already did it." Any default this
controller picked would be wrong somewhere, and a controller that validated
runtime names would be wrong about ferry, whose CRI is not containerd at all.

## Decision

**`Tool.spec.runtimeClassName` and `Agent.spec.runtimeClassName`**, passed
through to `PodSpec.RuntimeClassName` verbatim, plus a cluster-wide default
from `AGENT_DEFAULT_RUNTIME_CLASS` (Helm: `core-controller.runJob.defaultRuntimeClassName`).

Both fields are `*string`, following `corev1.PodSpec.RuntimeClassName`, with
three states:

| Value | Meaning |
| ----- | ------- |
| unset (`nil`) | inherit `AGENT_DEFAULT_RUNTIME_CLASS`, if set |
| `""` | explicitly the cluster's default runtime, overriding that default |
| `"<name>"` | that RuntimeClass |

The empty-string case is why this is a pointer rather than a plain string. A
cluster-wide default is the control an operator actually wants — isolation is
usually a posture, not a per-workload decision — but some tool will not
survive a sandboxed runtime, and "unset" cannot express "not this one."

Resolution happens once, in `resolveRuntimeClassName`, called from
`buildRunPodSpec`. Both execution backends and both run kinds therefore inherit
it from one place; `TestRuntimeClassReachesBothBackends` pins that, so
sandboxing a Tool can never depend on which backend happened to run it.

### What this deliberately does not do

- **No validation.** The controller does not check that a named RuntimeClass
  exists. A name that does not resolve leaves the pod unschedulable with the
  kubelet's own message, which is a better failure than this controller
  second-guessing an operator's runtime inventory — and on ferry there is no
  containerd to inventory.
- **No per-invocation override.** The field is on `Tool`/`Agent`, not
  `ToolRun`/`AgentRun`. Isolation is the operator's choice, and a per-run
  override would let a caller select a weaker runtime than the catalog entry
  asked for. This mirrors the split the README already draws: operators
  control the catalog, developers control the orchestrator.
- **No opinion about which runtime.** gVisor, Kata, a vendor sandbox, or
  ferry's pod-VMs are all a string to us.

### Verified

Against kind with `AGENT_DEFAULT_RUNTIME_CLASS=demo-sandboxed` and a
`RuntimeClass` of that name installed, all four cases land on the pod as
specified, and every run reached `Succeeded`:

| Run | `Tool.spec.runtimeClassName` | Backend | Pod's `runtimeClassName` |
| --- | ---------------------------- | ------- | ------------------------ |
| `rc-inherits` | unset | job | `demo-sandboxed` |
| `rc-pinned` | `demo-sandboxed` | job | `demo-sandboxed` |
| `rc-exempt` | `""` | job | *(none)* |
| `rc-on-sandbox` | unset | sandbox | `demo-sandboxed` |

The `""` case was also checked against the API server directly, since the
whole three-state design fails if `omitempty` drops it: the key persists with
an empty value, because the field is a pointer and `omitempty` only elides
`nil`.

## Consequences

Sandboxing the whole catalog is one Helm value, and exempting a workload that
breaks under it is one field. Neither requires a controller change, and
neither is coupled to the agent-sandbox execution backend — the two can be
adopted in either order, or independently.

The default is unchanged: with nothing configured, no `runtimeClassName` is
set and pods use the cluster's runtime exactly as before.

What this does **not** address is that a sandboxed runtime defends against
container escape, while our stated threat model (`docs/security.md`) is mostly
about prompt injection and SSRF — a container misbehaving with the access it
legitimately holds. gVisor does nothing about a mounted ServiceAccount token
or unrestricted egress, both of which are cheaper to fix and better matched to
that threat. This ADR makes the isolation lever available; it does not claim
it is the most valuable one.
