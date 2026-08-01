# 0011: Skills carry no RBAC of their own — access is derived from their tools

**Status:** accepted

## Context

Until now, `Tool`, `Skill`, and `Agent` all carried an independent
`allowedRoles` field, each enforced as a Qdrant payload filter at retrieval
time (ADR 0004's discipline, extended to skills by ADR 0008). That created
two overlapping grant surfaces with no coherence guarantee between them: a
skill with `allowedRoles: ["reader"]` could reference a tool with
`allowedRoles: ["admin"]`, and nothing caught the mismatch until runtime,
where `loadSkillTools` filtered every tool out and the caller got an opaque
`"skill has no usable tools for this caller"` error. The Go `SkillReconciler`
validated that `toolRefs` *exist*, but not that they were RBAC-compatible.

Options considered:

- **Validate coherence at reconcile time** (require
  `skill.allowedRoles ⊆ tool.allowedRoles` for every referenced tool, mark
  incoherent skills not-Ready): works, but keeps two sources of truth plus
  permanent validation machinery to hold them together.
- **Derive skill access from tool access** — chosen, based on the
  observation that *skills aren't dangerous; tools are*. A skill is trusted,
  operator-authored markdown plus a list of tool refs; retrieving one grants
  nothing by itself — all actual capability (Jobs, secrets, side effects)
  lives in tools (and agents). So tools/agents are the only grant surface,
  and a skill's audience is a *derived* property, not a declared one.

## Decision

- **`Skill.spec.allowedRoles` is removed** (CRD + orchestrator). `Tool` and
  `Agent` keep `allowedRoles` — they act, cost money, and touch secrets.
- **A skill's retrieval audience is derived at index time** as the
  **intersection** of its referenced tools' `allowedRoles`
  (`src/skills/derive-access.ts`): a caller sees a skill iff they can use
  *every* tool it declares. `Skill.spec.toolRefs` is now optional: a
  tool-less (respond-only) skill is **unrestricted** — retrievable by any
  caller with a resolved identity (empty/unresolved roles still fail closed).
- Fail-closed edge cases: a `toolRefs` entry missing from the tool catalog,
  or a disjoint intersection, yields an empty audience (skill retrievable by
  no one) with a startup `console.error` — never a silently-widened one.
- **Runtime backstops are unchanged** (defense in depth, ADR 0004):
  `loadSkillTools` still RBAC-filters via `getByIds`, and the graph still
  rejects planner tool picks outside the skill's scope. With derivation in
  place these should be unreachable; they remain as guards against index
  drift (e.g. a Tool CR changed/deleted after startup indexing).

## Consequences

- The skill-without-its-tools mismatch class disappears **by construction**
  — no reconciler coherence check, no two fields to keep in sync. Skill
  authors never reason about roles; tool authors do, exactly once, where the
  danger is.
- Respond-only skills (pure system-prompt knowledge) become possible and are
  readable by any authenticated caller. Corollary: **skill markdown must
  never contain secrets or privileged operational detail** (documented in
  docs/security.md). If a genuinely sensitive-knowledge skill ever appears,
  an optional explicit override could be reintroduced — deliberately not
  built now.
- Derivation happens at startup (same catalog load as ADR 0010) **and again
  on every subsequent Tool/LocalTool/Skill catalog change**, per
  [ADR 0020](0020-crd-catalog-hot-reload-via-k8s-watch.md) — a Tool CR
  `allowedRoles` change now reaches skill visibility within that watch's
  debounce window rather than only on the next orchestrator restart. This
  staleness window applies to authorization, not just catalog content —
  called out here explicitly rather than glossed over. The Qdrant skill
  payload gains
  `effectiveRoles`/`unrestricted` fields (replacing `allowedRoles`), and the
  retrieval filter becomes an OR of `unrestricted: true` and
  `effectiveRoles ∩ callerRoles ≠ ∅`.
- Existing Skill CRs with an `allowedRoles` field are tolerated by the API
  server (pruned as unknown) but the field is ignored — the sample
  `recipe-refining-skill.yaml` no longer sets it.
