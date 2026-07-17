/**
 * Session-scoped skill lifecycle (docs/adr/0012): a conversation keeps ONE
 * active skill across turns so follow-up messages ("yes, publish it") don't
 * re-run RAG skill selection with near-zero semantic signal. The record is a
 * best-effort routing hint, never correctness-critical state — losing it
 * (restart, TTL, eviction) just means the next turn falls back to full
 * retrieval + selection.
 *
 * Extended for agent delegation: at most ONE of `activeSkillId` /
 * `activeAgentRunId` is ever set for a given conversation at a time (a turn
 * either continues a skill or continues a running agent, never both) —
 * persisting one clears the other.
 */
export interface SessionRecord {
  /**
   * Identity subject the session belongs to. Conversation ids are
   * caller-supplied (e.g. Open WebUI's chat id header) and guessable, so
   * every read is checked against the freshly resolved identity — a
   * mismatch is treated as "no session" (docs/adr/0012).
   */
  subject: string;
  /**
   * Id of the conversation's active skill. Only the id is stored — the
   * skill content is re-fetched under the caller's CURRENT roles each turn
   * (fail-closed), so role revocation takes effect on the next message.
   */
  activeSkillId?: string;
  /**
   * Id of the Agent CR the conversation delegated to. Re-fetched under the
   * caller's CURRENT roles each turn (fail-closed), same discipline as
   * `activeSkillId` — needed to re-verify access before continuing the run.
   */
  activeAgentId?: string;
  /**
   * Name of the specific `AgentRun` CR the conversation is continuing. This
   * (not `activeAgentId`) is what a follow-up turn's `prompt` is published
   * to — the run's NATS subjects are keyed by this id, not by the catalog
   * Agent id, since one Agent can have many concurrent runs.
   */
  activeAgentRunId?: string;
  /**
   * Per-tool continuation tokens for this conversation, keyed by tool id
   * (docs/adr/0016). When the orchestrator's `runTool` node extracts a
   * `<!-- continuation: ... -->` marker from a tool's success output, the
   * opaque token is stored here and re-injected into tool_args on the next
   * turn for that same tool. The orchestrator stores/forwards the token
   * without ever parsing its content — each tool encodes its own state
   * (e.g. opencode-swe: repo/branch/pr/session; recipe-publisher: slug).
   */
  toolContinuations?: Record<string, string>;
  /** Last touch time (ms since epoch); used for sliding TTL expiry. */
  updatedAt: number;
}

/**
 * Port for conversation-session persistence. The default adapter is
 * in-memory ({@link InMemorySessionStore}) which assumes a single
 * orchestrator replica — a shared store (e.g. Redis) behind this same port
 * is the follow-up if the deployment ever scales out (docs/adr/0012).
 */
export interface SessionStore {
  get(sessionId: string): Promise<SessionRecord | undefined>;
  set(sessionId: string, record: Omit<SessionRecord, "updatedAt">): Promise<void>;
}
