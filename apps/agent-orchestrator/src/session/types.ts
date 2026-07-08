/**
 * Session-scoped skill lifecycle (docs/adr/0012): a conversation keeps ONE
 * active skill across turns so follow-up messages ("yes, publish it") don't
 * re-run RAG skill selection with near-zero semantic signal. The record is a
 * best-effort routing hint, never correctness-critical state — losing it
 * (restart, TTL, eviction) just means the next turn falls back to full
 * retrieval + selection.
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
  activeSkillId: string;
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
  get(sessionId: string): SessionRecord | undefined;
  set(sessionId: string, record: Omit<SessionRecord, "updatedAt">): void;
}
