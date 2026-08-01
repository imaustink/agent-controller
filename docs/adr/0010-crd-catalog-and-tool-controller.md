# 0010: Tool/Skill catalogs and Job launching move to CRDs reconciled by a Go controller

**Status:** accepted

> **Note:** this ADR file was reconstructed after an accidental workspace
> revert lost the original (2026-07-04); the decision itself has been live
> since 2026-07-03 and is reflected throughout the code (`CrdToolRegistry`,
> `CrdSkillRegistry`, `ToolRunLauncher`, `controllers/tool-controller/`).
>
> **Editorial note (2026-07-17):** the controller introduced here was later
> renamed `controllers/core-controller` (Helm subchart `charts/core-controller`,
> image `core-controller`) — by then it reconciled `Tool`, `Skill`, `Agent`,
> `ToolRun`, `AgentRun`, and `LocalTool` CRs, not just tools, so "tool-controller"
> no longer described what it did. This ADR's body below is left as originally
> written and still says `tool-controller` throughout.
>
> **Editorial note (2026-07-19):** the "one-shot-at-startup read, no watch
> loop yet" limitation called out below (and its restart-required staleness)
> is resolved by [ADR 0020](0020-crd-catalog-hot-reload-via-k8s-watch.md) —
> the orchestrator now watches Tool/LocalTool/Skill/Agent CRs live.

## Context

ADR 0009 made the tool catalog a static, build-time `manifest.json` per tool
baked into the orchestrator image. That fixed ADR 0004's chicken-and-egg
problem (no live Deployment to discover), but introduced its own frictions:

- Changing any catalog entry (description, roles, image, resources) requires
  rebuilding and redeploying the orchestrator image, even though nothing
  about the orchestrator's code changed.
- Skills (ADR 0008) were still a hand-authored TypeScript array
  (`src/skills/catalog.ts`) — even more coupled to the image than tools.
- The orchestrator built and launched Jobs itself (`K8sJobLauncher`),
  requiring broad `batch/jobs` permissions and putting the "how a hardened
  tool Job is shaped" logic inside the agent process.

## Decision

Introduce a set of CRDs under `core.controller-agent.dev/v1alpha1` — `Tool`,
`ToolRun`, `Skill`, `Agent`, `AgentRun` — reconciled by a dedicated Go
controller (`controllers/tool-controller/`, kubebuilder):

- **`Tool`** is pure catalog + launch metadata (description/input/output/
  `allowedRoles`/tier, image/serviceAccountName/env/`secretEnv`/resources).
  The orchestrator's `CrdToolRegistry` lists Tool CRs at startup and feeds
  them into the same RAG index as before (`ToolRegistry` port unchanged).
- **`Skill`** replaces the static skill catalog: `CrdSkillRegistry` lists
  Skill CRs at startup into the skills Qdrant collection. Skills become
  editable in-cluster (`kubectl apply`) without an image rebuild.
- **`ToolRun`** is the invocation interface: the orchestrator's
  `ToolRunLauncher` (implements the existing `JobLauncher` port) creates a
  ToolRun CR instead of a Job; the controller reconciles it into a hardened
  one-shot Job (same security contract as run.sh: cap-drop ALL, read-only
  rootfs, non-root, no privilege escalation) and reports status. Secrets are
  referenced by name/key (`secretKeyRef`), never inline.
- **`Agent`/`AgentRun`** mirror Tool/ToolRun for sub-agents (same catalog +
  run split, same callback protocol).

The orchestrator keeps its one-shot-at-startup read (no watch loop yet), so
catalog changes require an orchestrator restart — same staleness limitation
as ADR 0009, but the refresh no longer requires an image rebuild.

## Consequences

- "Register a tool/skill" is now `kubectl apply -f tool.yaml` /
  `skill.yaml` — no orchestrator rebuild. `tools/*/tool.yaml` and
  `apps/agent-orchestrator/config/samples/*.yaml` hold the CRs.
- The orchestrator no longer creates Jobs directly; only the Go controller
  does. The orchestrator's RBAC narrows to CRUD on the CRDs; the
  controller owns `batch/jobs`.
- Job-shape hardening logic lives once, in Go, testable with envtest —
  `K8sJobLauncher`/`ManifestToolRegistry`/`K8sAnnotationToolRegistry` remain
  in-tree but unwired (no git safety net for deletions).
- New moving part: the controller Deployment + CRDs must be installed
  (charts/tool-controller) before the orchestrator is useful.
- CRD changes require the regeneration chain: edit Go types → `make
  generate manifests` (the latter also syncs the CRD yaml into
  `charts/agent-controller/charts/core-controller/crds/`, which is generated
  and not committed) → rebuild controller image.
