import type { SubAgentApprovalPending } from "../agent/graph.js";
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

/**
 * Records that a running sub-agent has paused on a gated tool call awaiting the
 * caller's approval (ADR 0003 + sub-agent HITL), mirroring
 * {@link markAgentRunAwaitingReply}. The pause COEXISTS with the active-run
 * anchor: the run is still live and blocked on an unresolved `tool_result`, so
 * the anchor is kept (and the awaiting-reply flag set) alongside it.
 */
export async function markSubAgentApproval(
  store: SessionStore,
  sessionId: string,
  pending: SubAgentApprovalPending,
): Promise<void> {
  const existing = await store.get(sessionId);
  await store.set(sessionId, {
    ...existing,
    subject: existing?.subject ?? pending.subject,
    activeAgentId: pending.agentId,
    activeAgentRunId: pending.runId,
    activeAgentRunAwaitingReply: true,
    lastAgentRunId: pending.runId,
    subAgentApprovalPending: pending,
    activeSkillId: undefined,
  });
}

/**
 * Drops a sub-agent-approval pause while LEAVING the active-run anchor in place.
 *
 * Used by the timeout sweeper after it resolves the stranded tool call with a
 * failed `tool_result`: the sub-agent's run is still live and goes on to reason
 * over that failure, so the anchor (and its awaiting-reply flag) must survive so
 * the next turn re-attaches and collects the reply it produces — only the
 * pending-approval field is cleared.
 */
export async function clearSubAgentApproval(store: SessionStore, sessionId: string): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) return;
  await store.set(sessionId, { ...existing, subAgentApprovalPending: undefined });
}

/** The one capability the sweep needs from the agent channel — publishing a `tool_result`. */
export interface SubAgentApprovalResolver {
  resolveToolCall?(
    agentRunId: string,
    callId: string,
    outcome: { ok: true; result?: unknown } | { ok: false; error: string },
  ): Promise<void>;
}

/** The wire error a swept (timed-out) sub-agent approval resolves its held call with. Starts with the literal `approval_timeout` token so telemetry/tests can match it. */
export const SUBAGENT_APPROVAL_TIMEOUT_ERROR =
  "approval_timeout: Tool call was not approved in time and was not run.";

/**
 * One pass of the sub-agent-approval timeout sweep (ADR 0003 + sub-agent HITL),
 * extracted from `index.ts`'s timer so it is unit-testable. For every session
 * whose {@link SessionRecord.subAgentApprovalPending} has expired, resolves the
 * stranded `tool_call` with a FAILED `tool_result` (graceful degradation — the
 * sub-agent keeps reasoning, never a hard kill) and clears the pause, LEAVING
 * the active-run anchor so the next turn re-attaches and collects the reply the
 * sub-agent produces. Best-effort per entry: a failure is logged and retried
 * next tick. Returns how many approvals it timed out (handy for tests/metrics).
 */
export async function sweepExpiredSubAgentApprovals(
  store: SessionStore,
  channel: SubAgentApprovalResolver,
  now: number = Date.now(),
): Promise<number> {
  if (!channel.resolveToolCall || !store.listSubAgentApprovals) return 0;
  let pendings: Array<{ sessionId: string; pending: SubAgentApprovalPending }>;
  try {
    pendings = await store.listSubAgentApprovals();
  } catch (err) {
    console.warn("sub-agent approval sweep: listing failed:", err instanceof Error ? err.message : String(err));
    return 0;
  }
  let timedOut = 0;
  for (const { sessionId, pending } of pendings) {
    if (pending.expiresAt >= now) continue;
    try {
      await channel.resolveToolCall(pending.runId, pending.callId, {
        ok: false,
        error: SUBAGENT_APPROVAL_TIMEOUT_ERROR,
      });
      await clearSubAgentApproval(store, sessionId);
      timedOut += 1;
    } catch (err) {
      console.warn(
        `sub-agent approval sweep: failed to time out ${pending.runId}/${pending.callId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return timedOut;
}
