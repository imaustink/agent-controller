# 0020. Tool/Skill/Agent catalogs hot-reload via a live k8s watch

Status: accepted

## Context

Since ADR 0010, `CrdToolRegistry`/`CrdLocalToolRegistry`/`CrdSkillRegistry`/
`CrdAgentRegistry` all read their CRDs with a single `listNamespacedCustomObject`
call at startup, upserted once into the corresponding Qdrant collection, and
never looked again. A `Tool`/`LocalTool`/`Skill`/`Agent` CR created, edited, or
deleted after that point was invisible to the running orchestrator until it
was restarted — every one of these registries' docstrings called this out
explicitly as a known limitation ("one-shot-at-startup, no watch loop yet").

This bit in practice: a `Skill` CR (`web-search-skill`) applied to the cluster
after the orchestrator pod had already started its RAG index was never
indexed, and requests that should have matched it silently fell through to
`noMatchFallback` instead. The only fix was `kubectl rollout restart` — an
extra manual step after every catalog change, easy to forget, and a real
outage source for anything gated on "did the new capability actually show
up."

## Decision

Add a live k8s watch alongside each registry's existing `listAll()`, so the
catalog stays current without a restart:

- **`src/k8s/crd-watcher.ts`** (`makeCrdWatcher`): wraps
  `@kubernetes/client-node`'s `Watch` with an informer-style reconnect loop.
  The apiserver closes a watch's HTTP connection on its own timeout every few
  minutes even when nothing changed, and `Watch`'s `done` callback fires once
  per disconnect (not per event) — so `crd-watcher.ts` starts a fresh watch
  from `done` unconditionally, not just on error, with a fixed 2s backoff
  before reconnecting. A clean disconnect (`Watch.SERVER_SIDE_CLOSE`) is not
  reported as an error; anything else is passed to the caller's `onError`.
- **`ToolRegistry`/`SkillRegistry`/`AgentRegistry` (the `listAll()` ports)
  gain a `watch()` method** returning `{ stop() }`, taking an `onChange`
  callback of `CrdChangeEvent<T> = { type: "upsert", descriptor: T } |
  { type: "delete", id: string }`. Each `Crd*Registry.watch()` is a thin
  adapter over `makeCrdWatcher`: ADDED/MODIFIED decode through the same
  `toXDescriptor` conversion `listAll()` already uses and become `upsert`;
  DELETED carries only `metadata.name` (a DELETED event's `obj` is the CR's
  last known state before removal, not useful beyond the id) and becomes
  `delete`. `watchFn` is constructor-injected (real instances get
  `makeCrdWatcher(kubeConfig)` via `fromKubeConfig`) so registry unit tests
  can fake it without a real cluster connection, same pattern as the
  existing `api: CustomObjectsApiLike` injection for `listAll()`.
- **`index.ts` wires a watch per registry after the startup `listAll()` +
  upsert**, keeping an in-memory `Map` mirror of the current tool and skill
  catalogs (`toolsById`, `skillsById`):
  - Tool/LocalTool changes: update `toolsById`, upsert-or-delete the single
    changed descriptor directly against `vectorStore`, then schedule a
    debounced skill re-derive (see below) — a Tool's `allowedRoles` feeds
    `deriveSkillAccess` (ADR 0011), so a role change can change which skills
    are retrievable even though no Skill CR changed.
  - Skill changes: update `skillsById`, delete from `skillStore` directly on
    a DELETED event, and schedule the same debounced re-derive on
    ADDED/MODIFIED (a fresh skill still needs `deriveSkillAccess` run against
    the current tool list before it's upsertable).
  - Agent changes: a direct targeted upsert/delete against `agentStore` — an
    `AgentDescriptor` never depends on anything else in the catalog, so no
    reindex step is needed (only wired when `AGENT_NATS_URL` is set, mirroring
    the startup agent-catalog load).
  - The re-derive itself (`scheduleSkillReindex`) debounces on a 500ms timer:
    `deriveSkillAccess` needs the *full* current tool + skill lists, not just
    whichever one changed, so a burst of watch events (e.g. `kubectl apply -f`
    of several CRs at once) collapses into one re-derive + `skillStore.upsert`
    of every skill, not one per event.
  - All four watch handles are stopped in the existing `shutdown()` before
    closing everything else, so a reconnect never races process exit.

## Consequences

- Registering, editing, or removing a `Tool`/`LocalTool`/`Skill`/`Agent` CR
  now takes effect within roughly the watch's propagation time (typically
  sub-second) plus, for skills, the 500ms reindex debounce — no
  `kubectl rollout restart deployment/agent-orchestrator` step, and no more
  silent "the skill exists in the cluster but the orchestrator never saw it"
  failure mode.
- `listAll()` is unchanged and still used for the initial catalog load;
  `watch()` is purely additive. Every `Crd*Registry` constructor gains an
  optional trailing `watchFn` parameter — existing `listAll()`-only test
  construction (`new CrdToolRegistry(ns, group, version, api)`) is
  unaffected, since it's undefined by default and only `watch()` itself
  requires it (throws with a clear message if called on a registry built
  without one — this should never happen outside a test that doesn't need
  it).
- No RBAC changes needed: the orchestrator's Role
  (`charts/agent-controller/charts/agent-orchestrator/templates/rbac.yaml`)
  already granted `watch` alongside `get`/`list` on `tools`/`skills`/`agents`/
  `localtools` — it had just gone unused until now.
- The docstrings/READMEs/ADRs (0009, 0010, 0011) that previously called out
  "one-shot-at-startup, no watch loop yet" as a known limitation are updated
  to point here instead of being silently left stale.
- Tool role-change staleness (ADR 0011's called-out caveat) shrinks from "up
  to the next restart" to "up to the reindex debounce window" — still not
  instantaneous, but no longer restart-gated.
