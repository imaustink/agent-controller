# 0001: Parent orchestrator runs as its own container, launches tools/sub-agents as k8s Jobs

**Status:** accepted

## Context

The repo already runs each tool (e.g. `recipe-scraper`) as an isolated,
hardened, single-purpose Docker container (see [security.md](../security.md)).
Until now, "the parent orchestrator" was only referenced conceptually — what
calls these containers, and how, was explicitly out of scope. We now need to
build it: something that accepts a request, decides which tool/sub-agent
handles it, and runs that work on demand rather than keeping every tool
running idle.

Options considered:

- **Orchestrator embedded in each tool container** — rejected: couples
  reasoning/dispatch logic to a specific tool's runtime and dependencies, and
  would require every tool to carry cluster-admin-adjacent permissions
  (creating Jobs) just to be invoked.
- **Orchestrator as a long-running process outside k8s** (e.g. a plain VM
  process shelling to a k8s API) — rejected: loses the isolation/hardening
  benefits and standard deployment/scaling story that containers give every
  other component in this repo.
- **Orchestrator as its own container, deployed to k8s, launching tool/sub-agent
  work as k8s Jobs** — chosen.

## Decision

The orchestrator is a standalone container/deployment. It never runs tool code
in-process. Every tool call and every sub-agent delegation becomes a
**Kubernetes Job**, launched on demand, using the tool's own hardened image and
run contract already established for `recipe-scraper`.

## Consequences

- Clean RBAC boundary: the orchestrator's ServiceAccount can create/watch
  Jobs; tool ServiceAccounts cannot (see [ADR 0005](0005-kubernetes-client-node-job-launcher.md)
  and [orchestrator.md](../orchestrator.md#security-considerations)).
- Tool containers stay exactly as they are today — no changes needed to
  `recipe-scraper` or the shared hardening contract.
- Adds operational surface: the orchestrator needs its own Dockerfile,
  Deployment manifest, and cluster RBAC role — none of which exist yet.
- Sub-agents reuse the same "launch a Job" mechanism as tools (see
  [orchestrator.md](../orchestrator.md#5-sub-agents)), so no separate
  delegation code path is needed.
