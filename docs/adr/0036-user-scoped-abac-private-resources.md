# 0036. User-scoped ABAC: `allowedPrincipals` privately scopes a Tool/Agent/Skill on top of RBAC

Date: 2026-08-02

## Status

Proposed

Extends [0004](0004-rbac-scoped-dynamic-tool-discovery.md) (RBAC-scoped
retrieval) and [0011](0011-skill-access-derived-from-tools.md) (skill access
derived from tools/agents). Builds on the principal model from
[0030](0030-authorization-preflight-outside-the-llm.md) §6 and
[0031](0031-principal-establishing-account-link.md).

Resolves issue #149 ("User Scoped Skills, Agents and Tools").

## Context

Retrieval today is gated by RBAC alone (ADR 0004). Every `Tool`/`Agent` carries
a required `allowedRoles`, a caller carries `identity.roles`, and the vector
stores return a resource only when the two sets intersect; a `Skill` carries no
roles of its own and derives its audience from the tools/agents it references
(ADR 0011). Roles are coarse and shared: a role names a *class* of caller
(`reader`, `writer`, `admin`), not an individual.

Issue #149 asks for the missing axis: a user wants to create Skills, Agents, or
Tools that **only specific people** can discover and use — a resource private
to its owner (or a named handful of collaborators), regardless of how many
people share the role that would otherwise expose it. RBAC cannot express this
without minting a throwaway one-person role and attaching it everywhere, which
is exactly the per-record book-keeping RBAC exists to avoid.

The building block already exists. ADR 0030 §6 / ADR 0031 established the
**principal**: a stable per-human identifier (`github:<login>` when a verified
GitHub identity can be established, otherwise the entry-point `subject`),
resolved once in `resolveIdentity` and pinned onto `identity.principal`. It is
the natural subject for a per-user access rule.

## Decision

Add an optional **`allowedPrincipals: []string`** to `Tool`, `LocalTool`,
`Agent`, and `Skill` specs — an ABAC (attribute-based access control) layer
that scopes a resource to named principals, enforced by the orchestrator as an
**additional** retrieval filter on top of RBAC. It is never the controller's
concern (same as `allowedRoles`): the Go core-controller only stores the field;
`agent-orchestrator` enforces it.

### Semantics

- **Empty / unset = public** — RBAC alone gates the resource. This is today's
  behavior, unchanged, so every existing CR keeps working with no edit.
- **Non-empty = private** — the resource is a candidate for a caller only when
  **both** hold: RBAC passes (`allowedRoles ∩ callerRoles ≠ ∅`) **and** the
  caller's resolved principal is one of `allowedPrincipals`. The two axes are
  ANDed: private-scoping never *grants* access a role wouldn't, it only
  *narrows* it. (A resource meant to be reachable purely by ownership can pair
  a broad `allowedRoles` with a one-person `allowedPrincipals`.)
- The caller's principal is `identity.principal ?? identity.subject` — always
  present — so a private resource **fails closed** when it doesn't match, the
  same discipline ADR 0004 applies to unresolved roles.

### Skills derive ABAC the same way they derive RBAC

A `Skill` carries no `allowedRoles` (ADR 0011) but *may* carry its own
`allowedPrincipals` — private-scoping is an explicit owner intent, not a
capability grant, so it is the one access marker a Skill states directly. Its
**effective** ABAC audience (`derive-access.ts`) is the intersection of:

- the skill's own `allowedPrincipals`, and
- the `allowedPrincipals` of every referenced tool/agent that is **itself**
  private (a public tool/agent adds no constraint).

Intersecting — not unioning — is what stops a skill from ever widening a
private tool's audience: the planner may invoke any referenced tool, so the
caller must be permitted on all of them, exactly as with roles. A disjoint
result (`[]` with at least one private input) makes the skill authorable but
unreachable, surfaced via `console.error`, mirroring the disjoint-`effectiveRoles`
case. No private input at all yields `null` (unrestricted by ABAC).

### Enforcement is one shared filter, everywhere

`ToolQueryFilter`/`AgentQueryFilter`/`SkillQueryFilter` gain a required
`callerPrincipal`, and every store `query`/`getByIds` enforces ABAC beside the
existing RBAC clause. In Qdrant the resource payload gains `allowedPrincipals`
plus a denormalized `private` boolean, and the filter ANDs a nested
`should: [ private == false, allowedPrincipals ∋ callerPrincipal ]` under
`must`. The graph threads the principal through a single `callerFilter(identity)`
helper at every retrieval and id-lookup site, so ABAC is enforced identically
on RAG retrieval, the ADR 0012 active-skill re-fetch, the ADR 0033 active-agent
re-attach, IntegrationRoute forced targets (ADR 0024), and a skill's
`loadSkillTools` id resolution. Because a private resource never enters
`skillTools`/candidates, it can never be planned or run — the store filter is
the single choke point, so `runTool`/`delegateToAgent` need no separate check.

## Consequences

- A resource owner marks a CR private by listing principals; nothing else
  changes. Revoking a person is a one-line CR edit that takes effect within the
  ADR 0020 hot-reload window (the skill audience is re-derived on any
  Tool/Agent/Skill watch event).
- ABAC and RBAC are independent axes. A private respond-only skill (no roles, no
  tools) scoped to its owner is now expressible; so is a broadly-`allowedRoles`
  tool that only its owner can actually reach.
- **Rolling-upgrade safety.** A Qdrant point written before this field existed
  reads back with `private` absent; `match { value: false }` does not match a
  missing key, so such a point simply fails the ABAC clause until it is
  re-indexed (the catalog is re-listed at startup, ADR 0020) — fail-closed,
  never fail-open. Every upsert writes an explicit `private: false` for public
  resources so the common case matches immediately.
- **Not an execution-credential boundary.** `allowedPrincipals` gates
  *discovery and selection*, layered over RBAC. It is orthogonal to
  `identityProviders` (ADR 0022/0030/0032), which governs *whose credential* a
  launch runs with. A resource can use either, both, or neither.
- The principal is only as trustworthy as its resolver (ADR 0030 §6 / 0031): a
  caller with no verifiable GitHub identity is their own `subject`-based
  principal, so cross-entry-point private-scoping needs a linked identity, the
  same limitation the credential model already carries.
- Not addressed here: wildcard/group principals, an owner auto-added on CR
  create, or a UI for managing private lists. Listing principals explicitly on
  the CR is the v1 scope; groups can layer on later without changing the filter.
