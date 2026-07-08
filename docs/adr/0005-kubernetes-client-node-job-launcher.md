# 0005: Jobs are created via `@kubernetes/client-node`, not by shelling out to `kubectl`

**Status:** accepted

## Context

The orchestrator needs to create, watch, and clean up Kubernetes Jobs
(ADR 0001) whenever it launches a tool call or sub-agent. It needs a way to
talk to the k8s API.

Options considered:

- **Shell out to `kubectl`** — simpler to write one-off commands, but awkward
  to do programmatically: parsing CLI output, no typed request/response
  objects, harder to unit test (mocking a subprocess vs. mocking a client),
  and an extra binary dependency in the orchestrator's image.
- **`@kubernetes/client-node`, in-process** — chosen: typed `BatchV1Api`
  client, structured errors, testable via mocking the client, no subprocess or
  extra binary in the image.

## Decision

The orchestrator talks to the k8s API in-process via `@kubernetes/client-node`
(`BatchV1Api` for Job create/get/delete, plus watching Job/Pod status for
completion as a fallback to the callback-based result channel — see
[orchestrator.md](../orchestrator.md#4-kubernetes-job-launcher)). In-cluster
config (mounted ServiceAccount token) is used in production; kubeconfig is
used for local development. No `kubectl` binary is needed in the orchestrator
image.

## Consequences

- Orchestrator's Dockerfile stays minimal (no `kubectl` install step).
- Job creation/watching is unit-testable by mocking the client-node API
  surface, consistent with how the rest of this repo is tested (vitest).
- The orchestrator's ServiceAccount needs explicit RBAC (Role/RoleBinding) to
  create/get/watch/delete Jobs and read Pod logs, scoped to a namespace — this
  manifest doesn't exist yet and is part of the eventual implementation, not
  this design pass.
- Tool containers themselves are never granted these permissions (see
  [orchestrator.md](../orchestrator.md#security-considerations)) — only the
  orchestrator's own ServiceAccount can create Jobs.
