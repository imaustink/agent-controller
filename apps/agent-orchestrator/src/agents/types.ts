/**
 * An Agent is a full agent loop launched as a one-shot Job, retrievable via
 * RAG exactly like a Tool or Skill (top-level delegation target, alongside
 * Skills — the orchestrator queries both catalogs and picks the single best
 * match for a request). Unlike a Skill, selecting an Agent doesn't run more
 * of the orchestrator's own graph against a fixed tool list — it launches a
 * separate, full agent loop (an `AgentRun`) that holds a live, bidirectional
 * conversation with this orchestrator over NATS (progress, and
 * human-in-the-loop questions) until it produces a final reply.
 */
export interface AgentDescriptor {
  /** Stable identifier; also used as the vector-store point id. */
  id: string;
  name: string;
  /** Natural-language description — this is the text that gets embedded. */
  description: string;
  /** Roles/scopes allowed to select this agent; enforced as a retrieval filter (same discipline as Tool). */
  allowedRoles: string[];
  /** Optional coarse risk/cost tier, mirrors ToolDescriptor.tier. */
  tier?: string;
  /**
   * Guidance for THIS orchestrator's planner on how/when to delegate to the
   * agent and how to interpret its replies — trusted, catalog-authored
   * (same trust model as a Skill's markdown). Distinct from the sub-agent's
   * OWN internal system prompt (Agent CR's `agentPrompt`), which this
   * orchestrator never sees or needs.
   */
  orchestratorPrompt?: string;
  /** Everything needed to launch an AgentRun CR referencing this Agent. */
  agentRunTemplate: AgentRunTemplate;
}

export interface AgentRunTemplate {
  namespace: string;
  /** Name of the Agent CR this run targets (set by CrdAgentRegistry). */
  agentRef: string;
}

export interface AgentQueryFilter {
  /** Only agents whose `allowedRoles` intersects this set are returned. */
  callerRoles: string[];
}

export interface AgentSearchResult {
  agent: AgentDescriptor;
  score: number;
}

/**
 * Port every agent-store adapter implements (mirrors {@link VectorStore} in
 * ../vector-store/types.ts and {@link SkillStore} in ../skills/types.ts).
 */
export interface AgentStore {
  upsert(agents: AgentDescriptor[]): Promise<void>;
  /**
   * Similarity search scoped by `filter`. Implementations MUST fail closed:
   * an empty `filter.callerRoles` (unresolved identity) returns no results
   * rather than an unfiltered search (same discipline as Tool/Skill).
   */
  query(text: string, filter: AgentQueryFilter, k?: number): Promise<AgentSearchResult[]>;
  /**
   * Direct id lookup, same RBAC discipline as `query` — used to re-verify a
   * conversation's continuing agent run under the caller's CURRENT roles
   * each turn (role revocation takes effect immediately, mirrors
   * checkActiveSkill's getByIds re-check).
   */
  getByIds(ids: string[], filter: AgentQueryFilter): Promise<AgentSearchResult[]>;
  delete(ids: string[]): Promise<void>;
}

/** Port for discovering the current catalog of agents (mirrors ToolRegistry/SkillRegistry). */
export interface AgentRegistry {
  listAll(): Promise<AgentDescriptor[]>;
}
