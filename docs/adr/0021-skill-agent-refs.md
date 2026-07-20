# 0021. `Skill.spec.agentRefs` — Skills delegate to Agents directly, no Tool wrapper required

Status: accepted

## Context

`Skill.spec` (ADR 0010) has only ever had `toolRefs []string`, naming `Tool`
CRs. There is no `agentRef`/`agentRefs` on `Skill`. The only way an `Agent`
CR could ever be reached from a Skill was via `Tool.spec.agentRef`: an
"agent-backed Tool" that wraps the Agent, is loaded through the ordinary
`CrdToolRegistry`/tool RAG collection, and gets dispatched by `runTool`
(`agent/graph.ts`) as an `AgentRun` instead of a container Job the moment its
`agentRunTemplate` field is set (`tool-descriptor.ts`).

This is exactly how `self-improvement-skill` reached `opencode-swe-agent`: a
standalone `opencode-swe-agent-tool` `Tool` CR existed purely to forward to
the Agent, with `toolRefs: [opencode-swe-agent-tool]` on the Skill. That's an
extra CR (and an extra Helm-templated resource/values flag) whose only job is
indirection — there was no way to express "this skill may call this agent"
without first wrapping the agent in a tool.

## Decision

Add `Skill.spec.agentRefs []string` (`controllers/core-controller/api/v1alpha1/skill_types.go`),
naming `Agent` CRs a Skill may delegate to directly, alongside the existing
`toolRefs`. A Skill may declare either, both, or neither (respond-only).

**Go controller** (`SkillReconciler`): validates `agentRefs` resolve to real
`Agent` CRs in the same namespace, exactly mirroring the existing `toolRefs`
missing-ref check; both missing lists fold into one `Ready` condition
(`RefsMissing`/`RefsResolved`, renamed from `ToolRefsMissing`/reconciled).
Gains the same `agents` get/list/watch RBAC `ToolReconciler` already has for
its own single `agentRef` check.

**RBAC derivation** (ADR 0011): `deriveSkillAccess` (`skills/derive-access.ts`)
now takes tools AND agents, and intersects `allowedRoles` across BOTH
`toolIds` and `agentIds` — a Skill's audience is still "every caller who can
use everything it declares," just over two id spaces instead of one. A
respond-only skill is now "no toolIds AND no agentIds," not just no toolIds.

**Dispatch — deliberately zero new machinery.** `loadSkillTools` (the
`agent/graph.ts` node that resolves a selected Skill's callable set) resolves
`agentIds` via `agentStore.getByIds` and adapts each `AgentDescriptor` into
the exact `ToolDescriptor` shape an agent-backed Tool already produces —
`{ id, name, description, allowedRoles, tier, agentRunTemplate }` — then
concatenates it onto the tool-derived list. `action-planner.ts` (candidate
list, `tool_id` selection) and `runTool`'s `agentRunTemplate` dispatch branch
are completely unaware of whether a given entry came from a real Tool CR, an
agent-backed Tool, or a Skill's own `agentRefs` — they already only look at
whether `agentRunTemplate` is populated. No new `PlannedAction` variant, no
new graph node, no schema change to the OpenAI structured-output call.

**Catalog wiring** (`index.ts`): the `Agent` catalog LIST (a plain
`CrdAgentRegistry.listAll()`, no NATS/Qdrant needed) is now loaded *before*
the Skill section, not only inside the `if (config.natsUrl)` block that
builds the full agent-delegation bundle (`QdrantAgentStore`/`AgentRunLauncher`/
`NatsAgentChannel`) — `deriveSkillAccess` needs every agent's `allowedRoles`
regardless of whether full delegation machinery is configured. In an
HTTP-callback-only deployment (no NATS), the agent list is simply empty, so a
Skill's `agentRefs` fails closed the same way a dangling `toolRefs` entry
does — accurate, since agent delegation genuinely doesn't exist there.
`agentsById`, `toolsById`, and `skillsById` are all threaded into the
debounced `scheduleSkillReindex`. This corrects ADR 0020's claim that "an
Agent descriptor never depends on anything else in the catalog" — that was
true before Skills could reference agents; the Agent watch handler now also
updates `agentsById` and schedules a skill re-derive, same as a Tool change
already does.

**Proof case**: `self-improvement-skill` now declares
`agentRefs: [opencode-swe-agent]` directly. `opencode-swe-agent-tool` (the
`Tool` CR, its chart template, and its `opencodeSweAgentTool` values flag)
is deleted — it was pure indirection once `agentRefs` existed.

## Consequences

- A Skill can reach an Agent without a wrapper `Tool` CR. `Tool.spec.agentRef`
  wrapping still works and is NOT removed — `agentRefs` is additive, not a
  breaking change; wrapping remains reasonable when a Tool-shaped identity is
  wanted for other reasons (e.g. a stable name independent of the Agent CR).
- One fewer CR, one fewer Helm-templated resource, one fewer values flag per
  Skill that only ever needed to reach a single Agent.
- `derive-access.ts`'s fail-closed/disjoint-intersection discipline (ADR
  0011) is unchanged in spirit, just widened to two reference kinds.
- `index.ts` startup ordering is now agent-catalog-list, then tool catalog,
  then skill catalog+derivation — worth knowing before restructuring that
  file further; the full NATS agent-delegation bundle (Qdrant/launcher/
  channel) still only builds when `config.natsUrl` is set, reusing the
  already-fetched agent list rather than re-listing the cluster.
