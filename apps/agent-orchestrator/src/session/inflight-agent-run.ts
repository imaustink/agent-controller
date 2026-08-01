import type { SessionStore } from "./types.js";

/**
 * Records, mid-turn, that this conversation has an AgentRun in flight that it
 * is owed a reply from — the anchor a later turn re-attaches to
 * (`SessionRecord.activeAgentRunAwaitingReply`).
 *
 * Deliberately written BEFORE the wait rather than with the rest of the turn's
 * outcome. `InvokeServer.persistSession` runs after the graph returns, which is
 * fine for every outcome that has one; the failure this anchor exists for is the
 * orchestrator pod going away mid-wait, where the graph never returns at all and
 * a post-hoc write is exactly the write that doesn't happen. A rollout with a
 * bounded drain is the survivable version of that, a SIGKILL past the grace
 * period the unsurvivable one — both leave the anchor behind if it was written
 * up front, and neither does if it wasn't.
 *
 * Read-modify-write because `SessionStore.set` replaces the whole record:
 * everything already stored for the conversation (continuation tokens above
 * all) has to be carried over, or resumability would be bought by throwing away
 * cross-episode state.
 */
export async function markAgentRunAwaitingReply(
  store: SessionStore,
  sessionId: string,
  run: { subject: string; agentId: string; agentRunId: string },
): Promise<void> {
  const existing = await store.get(sessionId);
  await store.set(sessionId, {
    // `existing` carries an `updatedAt` the port's input type doesn't declare;
    // spreading it is harmless (every adapter stamps its own) and keeps this a
    // patch of whatever is stored rather than a rewrite of a subset of fields.
    ...existing,
    subject: existing?.subject ?? run.subject,
    activeAgentId: run.agentId,
    activeAgentRunId: run.agentRunId,
    activeAgentRunAwaitingReply: true,
    lastAgentRunId: run.agentRunId,
    // Mutually exclusive with an active skill by the same rule the
    // post-turn path follows (see `SessionRecord`): a turn continues a skill
    // or an agent run, never both.
    activeSkillId: undefined,
  });
}

/**
 * Drops the awaiting-reply anchor while leaving the rest of the record intact.
 *
 * Used when a re-attached wait establishes that there is nothing more to wait
 * for — the reply arrived, or the run is terminal and its answer is
 * unrecoverable. Without this the conversation would re-attach to a dead run on
 * every subsequent turn, silently spending each one's whole idle window before
 * falling through to ordinary handling.
 */
export async function clearAgentRunAwaitingReply(store: SessionStore, sessionId: string): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) return;
  await store.set(sessionId, {
    ...existing,
    activeAgentId: undefined,
    activeAgentRunId: undefined,
    activeAgentRunAwaitingReply: undefined,
  });
}
