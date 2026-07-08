# 0004: Tool catalog is discovered dynamically and filtered by caller RBAC, not a static manifest

**Status:** superseded by [0009](0009-static-build-time-tool-manifests.md) (discovery mechanism only)

> The dynamic-discovery half of this decision (part "a" below) was reversed
> in ADR 0009: tools are only ever launched on demand as one-shot Jobs (ADR
> 0005), so there's no live, always-running Deployment to discover in the
> first place. Kept here for history/rationale. The RBAC-scoped-query half
> of this decision (part "b") still stands unchanged — see ADR 0009's
> Consequences.

## Context

The RAG index (ADR 0003) needs a catalog of tool/sub-agent descriptors to
embed. Two independent questions came up together: (a) where does the catalog
come from, and (b) does every caller see the same catalog?

For (a):

- **Static manifest** (e.g. a checked-in `tool.json` per `tools/<name>/`) —
  simple, but can silently drift from what's actually deployed/runnable in the
  cluster, and requires a manual "register a tool" step.
- **Dynamic discovery from the cluster** — chosen: the registry is reconciled
  from objects that actually exist in k8s (candidate mechanisms: a
  `ToolDefinition` CRD, or annotations on each tool's Deployment/Job template),
  so the index can't reference a tool that isn't actually deployable. The
  exact mechanism (CRD vs. annotations) is left as an open question in
  [orchestrator.md](../orchestrator.md#open-questions-explicitly-deferred).

For (b):

- **Same catalog for every caller** — rejected: the whole point of adding RAG
  here is to let an organization expose *different* tools/sub-agents to
  different callers (e.g. internal-only tools, tiered access) without the
  agent core needing bespoke per-tool authorization logic.
- **RBAC-scoped catalog per caller identity** — chosen: the orchestrator
  resolves caller identity into roles/scopes before querying, and the query
  itself is filtered to only the tools those roles/scopes permit.

## Decision

Tool descriptors are discovered dynamically from the cluster (not hand
maintained), and every RAG query is issued with an identity-derived
role/scope filter so unauthorized tools are never retrieved as candidates in
the first place (fail closed on identity-resolution failure — see
[orchestrator.md](../orchestrator.md#security-considerations)).

## Consequences

- No static per-tool manifest file to keep in sync; deploying a tool with the
  right CRD/annotations is sufficient for it to become discoverable.
- Requires a reconciliation process (watch the cluster, upsert into the
  vector store on change) that doesn't exist yet — new component.
- Requires an identity → roles/scopes resolution step before every RAG query;
  the specific auth mechanism (IdP, claims mapping) is still an open question.
- RBAC must be enforced twice for defense in depth: once as a retrieval
  filter (this ADR), and again when the Job is actually launched under a
  role-appropriate ServiceAccount (ADR 0005).
