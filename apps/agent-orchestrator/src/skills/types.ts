import type { CrdChangeEvent } from "../k8s/crd-watcher.js";

/**
 * A Skill sits between a user's request and tool retrieval (docs/adr/0008):
 * it is RAG-matched against the request first, then its `markdown` is
 * injected as system-prompt context and its `toolIds` scope which tools the
 * agent may subsequently call. Unlike {@link ToolDescriptor}, skills are not
 * dynamically discovered from the cluster — they come from a small static
 * catalog (src/skills/catalog.ts) seeded into their own Qdrant collection.
 */
export interface SkillDescriptor {
  /** Stable identifier; also used as the vector-store point id. */
  id: string;
  name: string;
  /** Natural-language description — this is the text that gets embedded. */
  description: string;
  /**
   * System-prompt content injected when this skill is selected. Authored by
   * catalog maintainers (trusted), unlike scraped content or raw tool
   * descriptions elsewhere in this codebase.
   */
  markdown: string;
  /**
   * Ids of {@link ToolDescriptor}s this skill is allowed to invoke. May be
   * empty for respond-only skills (pure system-prompt knowledge).
   */
  toolIds: string[];
  /**
   * Ids of {@link AgentDescriptor}s (docs/adr/0021) this skill may delegate
   * to directly — dispatched as an AgentRun the same way an agent-backed
   * Tool already is, without needing a Tool CR to wrap the Agent first. May
   * be empty (or combined with toolIds — a skill isn't limited to one kind).
   */
  agentIds: string[];
  /**
   * ABAC private-scoping this skill declares of its OWN (docs/adr/0036 —
   * `Skill.spec.allowedPrincipals`). Distinct from the private-scoping INHERITED
   * from referenced tools/agents: derive-access.ts intersects this explicit
   * list with the referenced resources' `allowedPrincipals` to compute
   * {@link SkillAccess.effectivePrincipals}. Absent/empty means "no explicit
   * skill-level restriction" — the skill is still bound by whatever its
   * tools/agents are private to.
   */
  allowedPrincipals?: string[];
  /**
   * Whether consumer-supplied tools (docs/adr/0035 — the request body's `tools`
   * array, executed by the caller's own client) may be offered to the action
   * planner alongside this skill's own `toolIds`/`agentIds`.
   *
   * `undefined` means ALLOWED, matching `Skill.spec.allowCallerTools` being
   * unset: the default that agrees with the OpenAI wire contract is "the tools I
   * sent are usable", and a skill encoding an exact auditable procedure is the
   * exception that opts out. NOT an authorization boundary — caller tools carry
   * no RBAC at all, since the caller both supplies and runs them.
   */
  allowCallerTools?: boolean;
}

/**
 * A skill plus its derived retrieval audience (docs/adr/0011, extended by
 * ADR 0021 to agents). Skills carry no allowedRoles of their own — they are
 * trusted markdown, not capability; all RBAC lives on tools and agents.
 * `effectiveRoles` is computed by derive-access.ts as the intersection of
 * the referenced tools' AND agents' `allowedRoles`; `null` means
 * unrestricted (a skill with no toolIds/agentIds — any caller with a
 * resolved identity may select it).
 */
export interface SkillAccess {
  skill: SkillDescriptor;
  effectiveRoles: string[] | null;
  /**
   * Derived ABAC audience (docs/adr/0036): the intersection of the
   * `allowedPrincipals` of the skill itself AND every referenced tool/agent
   * that is itself private. `null` means unrestricted by ABAC (neither the
   * skill nor any referenced tool/agent is private — today's behavior); a
   * non-empty array means the skill is private to exactly those principals; an
   * empty array means the private sets are disjoint, so the skill is
   * authorable but unreachable (surfaced via console.error, mirrors the
   * disjoint-`effectiveRoles` case).
   *
   * Optional so a `SkillAccess` built before this field existed (or by a test)
   * still type-checks; consumers treat `undefined` as `null` (unrestricted).
   */
  effectivePrincipals?: string[] | null;
}

/**
 * Metadata filter applied at query time — same shape/discipline as
 * {@link ToolQueryFilter} in ../vector-store/types.ts.
 */
export interface SkillQueryFilter {
  /**
   * Only skills whose derived `effectiveRoles` intersects this set — or
   * unrestricted skills (`effectiveRoles: null`) — are returned.
   */
  callerRoles: string[];
  /**
   * The caller's resolved principal (docs/adr/0030 §6 — `identity.principal`,
   * falling back to `identity.subject`), used to enforce ABAC private-scoping
   * (docs/adr/0036): a skill with a non-empty derived `effectivePrincipals` is
   * returned only when this value is one of them. Always supplied by the graph
   * (a subject is always present), so a private skill fails closed when it
   * doesn't match.
   */
  callerPrincipal: string;
}

export interface SkillSearchResult {
  skill: SkillDescriptor;
  score: number;
}

/**
 * Port every skill-store adapter implements (mirrors {@link VectorStore} /
 * ADR 0003). The agent core only ever depends on this interface.
 */
export interface SkillStore {
  upsert(skills: SkillAccess[]): Promise<void>;
  /**
   * Similarity search scoped by `filter`. Implementations MUST fail closed:
   * an empty `filter.callerRoles` (unresolved identity) returns no results
   * rather than an unfiltered search — this applies to unrestricted skills
   * too ("unrestricted" still requires a resolved identity with ≥1 role).
   */
  query(text: string, filter: SkillQueryFilter, k?: number): Promise<SkillSearchResult[]>;
  /**
   * Direct id lookup (no similarity scoring), same RBAC discipline as
   * `query` — fail closed on empty `callerRoles`, and skills whose derived
   * audience doesn't cover the caller are silently omitted. Used by the
   * `checkActiveSkill` graph node (docs/adr/0012) to re-fetch a
   * conversation's active skill under the caller's CURRENT roles each turn,
   * so role revocation takes effect immediately (skill content is never
   * cached across turns).
   */
  getByIds(ids: string[], filter: SkillQueryFilter): Promise<SkillDescriptor[]>;
  delete(ids: string[]): Promise<void>;
}

/**
 * Port for discovering the current catalog of skills (mirrors {@link
 * ToolRegistry} in ../registry/types.ts). Introduced by ADR 0010 —
 * `CrdSkillRegistry` (reads `Skill` custom resources) implements it;
 * `index.ts` previously read the static `catalog.ts` array directly instead
 * of going through a port at all (that file is left in place, unwired, per
 * this repo's convention of not deleting superseded code without a git
 * safety net).
 */
export interface SkillRegistry {
  listAll(): Promise<SkillDescriptor[]>;
  /**
   * Live catalog updates after the initial `listAll()` (ADR 0020) -- a Skill
   * CR created/edited/deleted after startup is reported here instead of only
   * taking effect on the next orchestrator restart. Returns a handle to stop
   * watching (used on shutdown).
   */
  watch(
    onChange: (event: CrdChangeEvent<SkillDescriptor>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void };
}
