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
}

/**
 * A skill plus its derived retrieval audience (docs/adr/0011). Skills carry
 * no allowedRoles of their own — they are trusted markdown, not capability;
 * all RBAC lives on tools (and agents). `effectiveRoles` is computed by
 * derive-access.ts as the intersection of the referenced tools'
 * `allowedRoles`; `null` means unrestricted (a skill with no toolIds — any
 * caller with a resolved identity may select it).
 */
export interface SkillAccess {
  skill: SkillDescriptor;
  effectiveRoles: string[] | null;
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
}
