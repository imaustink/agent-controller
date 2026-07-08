# 0009: Tool catalog is a static, build-time manifest per tool (supersedes dynamic Deployment discovery)

**Status:** superseded by [0010](0010-crd-catalog-and-tool-controller.md)

> **Editorial note (2026-07-03):** the manifest-per-tool mechanism described
> here was itself replaced by `Tool` custom resources reconciled by the Go
> tool-controller (ADR 0010). The core insight (tools are one-shot Jobs, so
> there is nothing running to "discover") still stands and carried through
> to the CRD design.

## Context

ADR 0004 chose dynamic discovery from the cluster (candidate mechanisms: a
`ToolDefinition` CRD, or annotations on each tool's Deployment) over a static
manifest, specifically to avoid the catalog drifting from what's actually
deployed/runnable.

That reasoning had a flaw: tools are never long-running services. Per ADR
0001/0005, every tool/sub-agent invocation is a **one-shot Kubernetes Job**
launched on demand — there is no always-running Deployment for a tool in
normal operation. Annotation-based discovery (`k8s-discovery.ts`) only ever
read two fields off a Deployment (`image`, `serviceAccountName`) and never
actually invoked or scaled it; the Deployment existed purely as a container
for that metadata. Making this work in practice would have meant keeping a
perpetual `replicas: 0` Deployment around for every tool, solely so it could
be "discovered" — a workload object that intentionally never runs any pods.
That's backwards: it re-introduces exactly the kind of always-on resource the
Job-based design (ADR 0001) was chosen to avoid, just to satisfy a discovery
mechanism.

A CRD (e.g. `ToolDefinition`) would have avoided the Deployment-shaped
awkwardness, but still requires installing a cluster-scoped CRD schema and
running some kind of reconciler — real infrastructure to stand up for what is,
in practice, a handful of tools that change rarely (adding a new tool is
already a multi-step, deliberate process per the root README's "Adding a new
tool" checklist).

## Decision

Each tool ships a `manifest.json` in its own `tools/<name>/` directory,
describing:

- `id`/`name`/`description` — what the tool does.
- `input`/`output` — the shape of what it consumes/produces, in plain
  language (this is new relative to ADR 0004's `ToolDescriptor`, which only
  had a single `description` string — richer text improves RAG match
  quality and doubles as documentation).
- `allowedRoles`/`tier` — same RBAC-filter metadata as before (ADR 0004's
  part "b", unchanged).
- `image`/`serviceAccountName`/`args`/`env`/`resources` — the Job template
  (unchanged shape from `JobTemplate`).

The orchestrator's Dockerfile copies **only each tool's `manifest.json`**
(never its source or dependencies) into the image at build time, one `COPY`
line per tool. `ManifestToolRegistry` (`src/registry/manifest-tool-registry.ts`)
reads every `<manifestsDir>/<tool>/manifest.json` once at startup and upserts
the resulting `ToolDescriptor`s into the RAG index — structurally the same
`ToolRegistry` port (`listAll(): Promise<ToolDescriptor[]>`) as the
superseded `K8sAnnotationToolRegistry`, so nothing downstream (vector store,
agent graph) changed.

`K8sAnnotationToolRegistry`/`k8s-discovery.ts` is kept in the tree (still
unit-tested) but is no longer wired into `index.ts`, in case live-cluster
discovery becomes worth revisiting for a different tool shape later (e.g.
genuinely long-running sub-agent services rather than one-shot Jobs).

## Consequences

- **Registering a tool is now:** add `tools/<name>/manifest.json`, add one
  `COPY` line to the orchestrator's Dockerfile, rebuild the orchestrator
  image. No cluster annotations/CRD objects to keep in sync.
- **The orchestrator's own RBAC shrinks**: it no longer needs `get/list/watch`
  on `apps/deployments` at all (see the Helm chart's `templates/rbac.yaml`) —
  only `batch/jobs` permissions remain, since discovery no longer touches the
  k8s API.
- **New staleness risk, traded deliberately**: the catalog only changes when
  the orchestrator image is rebuilt/redeployed with updated manifests — there
  is no live drift detection between a manifest and whether that tool's
  image/ServiceAccount still exist or are compatible (added to
  [orchestrator.md's open questions](../orchestrator.md#open-questions-explicitly-deferred)).
  This is the opposite tradeoff from ADR 0004, made deliberately given the
  one-shot-Job reality above.
- **RBAC-scoped-query part of ADR 0004 (part "b") is unchanged**: every RAG
  query is still filtered by the caller's resolved roles, failing closed on
  an empty candidate set — this ADR only reverses *where the catalog comes
  from*, not *who can see what in it*.
- Manifests are semi-trusted LLM-visible input (a tool's description/input/
  output text is embedded and later becomes RAG context) — same discipline as
  the semi-trusted tool descriptions ADR 0004 already called out, just now
  authored in a file instead of a cluster annotation.
