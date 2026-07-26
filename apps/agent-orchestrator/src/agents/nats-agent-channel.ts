import { randomUUID } from "node:crypto";
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import {
  AgentUpMessageSchema,
  NATS_RECONNECT_OPTIONS,
  agentSubjects,
  type AgentDownMessage,
  type AgentUpMessage,
} from "@controller-agent/messaging";

/** Accumulated result of awaiting one agent turn (see {@link AgentOrchestratorChannel.awaitReply}). */
export interface AgentTurnResult {
  message: string;
  /** false = the agent is asking a question / awaiting a further prompt; true = the agent is done and exiting. */
  final: boolean;
  result?: unknown;
  /** Progress/warning narration collected while waiting, oldest first (not streamed live in v1 — see graph.ts). */
  narration: string[];
}

/**
 * The agent went silent — no up-message of any kind for the idle window (see
 * {@link DEFAULT_IDLE_TIMEOUT_MS}). Distinct from
 * {@link AgentTurnTransportError}: this means the run itself is unresponsive,
 * not that we lost our ability to hear it.
 */
export class AgentTurnTimeoutError extends Error {}
/**
 * We stopped being able to observe the run — NATS connection dropped, the
 * subscription was closed out from under us, a permission error, etc. The
 * agent is very likely still running fine and may well succeed; we simply
 * can't see its reply. Kept separate from {@link AgentTurnTimeoutError}
 * because these were previously conflated, producing the actively misleading
 * "produced no reply within 3660000ms" on a run that was healthy and went on
 * to succeed — the number was the *configured* bound, never the elapsed time.
 *
 * Callers treat this as a RESUMABLE pause rather than a failure (docs/adr/0033):
 * the agent holds its concluding message until acked, so the next turn can
 * re-attach and collect it. Reporting it honestly was the previous fix; not
 * losing the answer is this one.
 */
export class AgentTurnTransportError extends Error {}
export class AgentTurnFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Result of a forwarded live-tunnel HTTP call (ADR 0026). */
export interface OpencodeProxyResult {
  status: number;
  body?: unknown;
}

/**
 * Orchestrator-side counterpart to `@controller-agent/agent-runtime`'s
 * `NatsChannel` — subscribes to an agent run's up subject and publishes to
 * its down subject. One shared connection for the whole process (the
 * orchestrator is long-lived); subjects are deterministic per run id
 * (see `agentSubjects`), so a fresh per-call subscription works across
 * separate HTTP turns without needing to keep any per-run state open.
 */
export interface AgentOrchestratorChannel {
  /**
   * Subscribes to `agentRunId`'s up subject and resolves on the first
   * `reply` or `failed` message (progress/warning are collected into
   * `narration`, and forwarded live to `opts.onProgress` if given, but do
   * not resolve the promise themselves). Call this BEFORE triggering
   * whatever makes the agent respond (launching the AgentRun, or
   * `sendPrompt`) so a fast reply can never be missed by a late
   * subscription.
   *
   * `opts.onToolCall` (docs/adr/0028) is invoked for every `tool_call`
   * up-message seen while waiting — fired without blocking the read loop, so
   * the caller must dispatch it asynchronously (e.g. via `void` fire-and-
   * forget) and eventually call {@link resolveToolCall} with the same
   * `callId`. More than one may arrive before the first resolves.
   *
   * `opts.idleTimeoutMs` bounds SILENCE, not total duration: every
   * up-message (including progress/warning narration) resets it. A coding
   * task that legitimately runs for hours while narrating is never cut off;
   * only a run that has genuinely stopped saying anything is given up on.
   *
   * The idle clock is PAUSED while any `tool_call` from this run is
   * outstanding: the agent is blocked on a `tool_result` only we can send, so
   * its silence is expected and says nothing about its health. The clock
   * resumes when the last outstanding call is answered via
   * {@link resolveToolCall}. Without that pause, a container tool running
   * longer than the idle window would be reported as an unresponsive agent —
   * the hazard ADR 0028 records under "Consequences".
   */
  awaitReply(
    agentRunId: string,
    opts?: {
      idleTimeoutMs?: number;
      onProgress?: (stage: string | undefined, message: string) => void;
      onToolCall?: (call: { callId: string; tool: string; input: string }) => void;
    },
  ): Promise<AgentTurnResult>;
  /** Sends a follow-up user turn to an already-running agent (HITL continuation, or a fresh follow-up turn). */
  sendPrompt(agentRunId: string, message: string): Promise<void>;
  /**
   * Publishes the `tool_result` down-message correlated to a `tool_call`
   * surfaced via `awaitReply`'s `onToolCall` (docs/adr/0028) — the
   * counterpart of `callTool` on the agent-runtime SDK side. Optional, same
   * reason as `subscribeLive`/`forwardOpencodeRequest`: only `NatsAgentChannel`
   * implements it; existing test fakes that never exercise `onToolCall` don't
   * need to.
   */
  resolveToolCall?(
    agentRunId: string,
    callId: string,
    outcome: { ok: true; result?: unknown } | { ok: false; error: string },
  ): Promise<void>;
  /**
   * Long-lived subscription to `agentRunId`'s up subject (ADR 0026), for a
   * live viewer -- forwards every validated up-message (not just
   * `opencode_event`; the caller filters) until `unsubscribe()` is called.
   * Unlike `awaitReply`, never resolves/unsubscribes on its own. Optional --
   * only `NatsAgentChannel` implements it; existing test fakes that only
   * exercise the ordinary conversational path don't need to.
   */
  subscribeLive?(agentRunId: string, onMessage: (msg: AgentUpMessage) => void): { unsubscribe(): void };
  /**
   * Forwards an HTTP call into `agentRunId`'s local opencode server (ADR
   * 0026) as an `opencode_request` down-message, and awaits the correlated
   * `opencode_response`. `timeoutMs` defaults generously (a live prompt can
   * take as long as an ordinary agent turn). Optional, same reason as
   * `subscribeLive`.
   */
  forwardOpencodeRequest?(
    agentRunId: string,
    req: { method: string; path: string; body?: unknown },
    timeoutMs?: number,
  ): Promise<OpencodeProxyResult>;
  close(): Promise<void>;
}

/**
 * Default silence window before an agent turn is given up on. Reset by every
 * up-message, so this bounds how long the agent goes QUIET, never how long it
 * runs in total — a run may legitimately take hours.
 *
 * 10 minutes is ~30x the longest cadence any healthy agent goes without
 * saying something:
 *   - during ordinary work the up subject carries every `opencode_event`
 *     (`opencode-swe-agent`'s `subscribeEvents`), i.e. near-continuous;
 *   - the remote-control wait — the one place a turn blocks on a human —
 *     heartbeats "still running…" every 20s (`claude-runner.ts`) and caps
 *     itself at 30 min anyway.
 *
 * Note that an agent asking a question does NOT sit inside `awaitReply`:
 * `ask()` publishes `reply{final:false}` (`agent-runtime`'s `runtime.ts`),
 * which returns from here immediately and parks the human wait between turns.
 * An earlier version of this constant was sized at 30 min to "wait on a
 * human", which this call path never does.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Default bound for a forwarded `opencode_request` -- as long as an ordinary agent turn might take. */
const DEFAULT_OPENCODE_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * An in-flight `awaitReply`'s idle clock, shared with `resolveToolCall` so
 * answering the last outstanding `tool_call` restarts the clock immediately.
 */
interface IdleClock {
  owedToolResults: Set<string>;
  arm(): void;
}

export class NatsAgentChannel implements AgentOrchestratorChannel {
  private readonly codec = JSONCodec<unknown>();
  private seq = 0;
  /** Keyed by agent run id; one entry per in-flight `awaitReply`. */
  private readonly idleClocks = new Map<string, IdleClock>();

  private constructor(
    private readonly nc: NatsConnection,
    private readonly subjectPrefix: string,
  ) {}

  static async connect(natsUrl: string, subjectPrefix = "agent"): Promise<NatsAgentChannel> {
    const nc = await connect({ servers: natsUrl, ...NATS_RECONNECT_OPTIONS });
    return new NatsAgentChannel(nc, subjectPrefix);
  }

  /**
   * Test-only constructor bypass: builds a channel over an already-established
   * (or faked) connection instead of dialing NATS via {@link connect}. Keeps
   * the `private constructor` invariant ("channels are built via `.connect()`")
   * intact for production callers while letting unit tests inject an in-memory
   * `NatsConnection` stand-in without a type cast around the private ctor.
   */
  static forTest(nc: NatsConnection, subjectPrefix = "agent"): NatsAgentChannel {
    return new NatsAgentChannel(nc, subjectPrefix);
  }

  private decode(data: Uint8Array): AgentUpMessage | undefined {
    let decoded: unknown;
    try {
      decoded = this.codec.decode(data);
    } catch {
      return undefined; // ignore non-JSON garbage on the subject
    }
    const parsed = AgentUpMessageSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  }

  async awaitReply(
    agentRunId: string,
    opts: {
      idleTimeoutMs?: number;
      onProgress?: (stage: string | undefined, message: string) => void;
      onToolCall?: (call: { callId: string; tool: string; input: string }) => void;
    } = {},
  ): Promise<AgentTurnResult> {
    const { up } = agentSubjects(agentRunId, this.subjectPrefix);
    const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    // Deliberately NOT nats.js's `{ timeout }` subscribe option: that is a
    // FIRST-MESSAGE timeout, cancelled by `SubscriptionImpl.callback()` on the
    // first message of any type. Since every agent narrates progress within
    // seconds of starting, it was cancelled immediately and bounded nothing at
    // all for the rest of the run. We keep our own timer and reset it on each
    // message instead, which is the idle semantics we actually want.
    const sub = this.nc.subscribe(up);
    const narration: string[] = [];

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // `tool_call`s dispatched to us and not yet answered (docs/adr/0028).
    const owedToolResults = new Set<string>();
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      // Paused: the agent is blocked waiting on a `tool_result` from us, so
      // its silence is our doing and is not evidence it has stopped working.
      if (owedToolResults.size > 0) return;
      idleTimer = setTimeout(() => {
        timedOut = true;
        // Ends the `for await` below without a value; the post-loop throw
        // distinguishes this from a transport-level close via `timedOut`.
        sub.unsubscribe();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    // Published so `resolveToolCall` can restart the clock the moment the last
    // outstanding call is answered, rather than waiting for the agent's next
    // message to do it.
    const clock: IdleClock = { owedToolResults, arm: armIdleTimer };
    this.idleClocks.set(agentRunId, clock);

    try {
      armIdleTimer();
      for await (const m of sub) {
        const msg = this.decode(m.data);
        // Reset on any traffic on the subject, decodable or not — garbage on
        // the wire still means something upstream is alive and talking.
        armIdleTimer();
        if (!msg) continue;

        switch (msg.type) {
          case "ready":
            break;
          case "progress":
            narration.push(msg.message);
            opts.onProgress?.(msg.stage, msg.message);
            break;
          case "warning":
            narration.push(`Warning: ${msg.message}`);
            opts.onProgress?.("warning", msg.message);
            break;
          case "reply":
            // Ack BEFORE unsubscribing/returning: the agent holds its
            // concluding message until this lands (see the protocol's
            // `reply_ack`), re-offering it meanwhile, and a re-offer arriving
            // after we unsubscribe would be dropped. A non-final reply (a HITL
            // question) is acked too -- losing a question strands the
            // conversation exactly the way losing an answer does.
            this.ackConcluding(agentRunId, msg.seq);
            sub.unsubscribe();
            return { message: msg.message, final: msg.final, result: msg.result, narration };
          case "failed":
            this.ackConcluding(agentRunId, msg.seq);
            sub.unsubscribe();
            throw new AgentTurnFailedError(msg.code, msg.message);
          case "tool_call":
            // ADR 0028 "Consequences" noted that a long-running container tool
            // emitting no up-messages could exhaust this subscription's window
            // and surface as a generic agent timeout. It no longer can: an
            // unanswered `tool_call` pauses the idle clock (see `armIdleTimer`)
            // until `resolveToolCall` answers it, so the tool's own timeout is
            // what bounds the tool, and this window only ever measures silence
            // the agent is actually responsible for.
            owedToolResults.add(msg.callId);
            armIdleTimer();
            opts.onToolCall?.({ callId: msg.callId, tool: msg.tool, input: msg.input });
            break;
          default:
            break; // opencode_event/opencode_response/session_idle/session_ended (ADR 0026) irrelevant here -- see subscribeLive/forwardOpencodeRequest
        }
      }
      if (timedOut) {
        throw new AgentTurnTimeoutError(
          `agent run ${agentRunId} went silent for ${idleTimeoutMs}ms after ${narration.length} progress message(s)`,
        );
      }
      // Iterator ended while the agent was still, as far as we know, working:
      // the subscription or the whole connection was closed under us.
      throw new AgentTurnTransportError(
        `lost the NATS subscription for agent run ${agentRunId} before it replied; the run may still be in progress`,
      );
    } catch (err) {
      if (
        err instanceof AgentTurnFailedError ||
        err instanceof AgentTurnTimeoutError ||
        err instanceof AgentTurnTransportError
      ) {
        throw err;
      }
      // A NATS error (connection closed, permission denied, ...) surfaces as a
      // rejected iterator. It is NOT evidence the agent failed or went quiet.
      throw new AgentTurnTransportError(
        `lost the NATS subscription for agent run ${agentRunId} before it replied (${err instanceof Error ? err.message : String(err)}); the run may still be in progress`,
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      // Only retract our own registration -- a later turn on the same run id
      // may already have replaced it.
      if (this.idleClocks.get(agentRunId) === clock) this.idleClocks.delete(agentRunId);
    }
  }

  /**
   * Confirms receipt of a concluding up-message so the agent can stop holding
   * it (see the protocol's `reply_ack`). Fire-and-forget by design: if this ack
   * is itself lost the agent simply re-offers, and the next receipt acks again.
   */
  private ackConcluding(agentRunId: string, ackSeq: number): void {
    const { down } = agentSubjects(agentRunId, this.subjectPrefix);
    const msg: AgentDownMessage = {
      type: "reply_ack",
      ackSeq,
      agent_run_id: agentRunId,
      seq: this.seq++,
      ts: new Date().toISOString(),
    };
    this.nc.publish(down, this.codec.encode(msg));
  }

  async sendPrompt(agentRunId: string, message: string): Promise<void> {
    const { down } = agentSubjects(agentRunId, this.subjectPrefix);
    const msg: AgentDownMessage = {
      type: "prompt",
      message,
      agent_run_id: agentRunId,
      seq: this.seq++,
      ts: new Date().toISOString(),
    };
    this.nc.publish(down, this.codec.encode(msg));
  }

  async resolveToolCall(
    agentRunId: string,
    callId: string,
    outcome: { ok: true; result?: unknown } | { ok: false; error: string },
  ): Promise<void> {
    const { down } = agentSubjects(agentRunId, this.subjectPrefix);
    const msg: AgentDownMessage = {
      type: "tool_result",
      callId,
      ...outcome,
      agent_run_id: agentRunId,
      seq: this.seq++,
      ts: new Date().toISOString(),
    };
    this.nc.publish(down, this.codec.encode(msg));
    // The agent is unblocked as of this publish, so it owes us traffic again --
    // restart the idle clock if this was the last call it was waiting on.
    const clock = this.idleClocks.get(agentRunId);
    if (clock) {
      clock.owedToolResults.delete(callId);
      clock.arm();
    }
  }

  subscribeLive(agentRunId: string, onMessage: (msg: AgentUpMessage) => void): { unsubscribe(): void } {
    const { up } = agentSubjects(agentRunId, this.subjectPrefix);
    const sub: Subscription = this.nc.subscribe(up);
    void (async () => {
      for await (const m of sub) {
        const msg = this.decode(m.data);
        if (msg) onMessage(msg);
      }
    })().catch(() => {
      // Subscription closed (unsubscribe()) or connection dropped -- nothing to recover, caller already knows via disconnect.
    });
    return { unsubscribe: () => sub.unsubscribe() };
  }

  async forwardOpencodeRequest(
    agentRunId: string,
    req: { method: string; path: string; body?: unknown },
    timeoutMs = DEFAULT_OPENCODE_PROXY_TIMEOUT_MS,
  ): Promise<OpencodeProxyResult> {
    const { up, down } = agentSubjects(agentRunId, this.subjectPrefix);
    const requestId = randomUUID();
    // Subscribe BEFORE publishing (same discipline as awaitReply) so a fast
    // response can never be missed by a late subscription. Own timer rather
    // than nats.js's `{ timeout }` for the same reason as awaitReply: that
    // option is cancelled by the first message on the subject, and this
    // subject carries unrelated `opencode_event` traffic that would cancel it
    // long before our correlated response arrives. Unlike awaitReply this is
    // a fixed deadline, not idle-reset — one HTTP round-trip either completes
    // or it doesn't.
    const sub = this.nc.subscribe(up);
    const deadline = setTimeout(() => sub.unsubscribe(), timeoutMs);
    deadline.unref?.();

    const waitForResponse = (async (): Promise<OpencodeProxyResult> => {
      for await (const m of sub) {
        const msg = this.decode(m.data);
        if (msg?.type === "opencode_response" && msg.requestId === requestId) {
          return { status: msg.status, body: msg.body };
        }
      }
      throw new AgentTurnTimeoutError(`agent run ${agentRunId} did not respond to opencode_request ${requestId} within ${timeoutMs}ms`);
    })();

    const downMsg: AgentDownMessage = {
      type: "opencode_request",
      requestId,
      method: req.method,
      path: req.path,
      body: req.body,
      agent_run_id: agentRunId,
      seq: this.seq++,
      ts: new Date().toISOString(),
    };
    this.nc.publish(down, this.codec.encode(downMsg));

    try {
      return await waitForResponse;
    } catch (err) {
      if (err instanceof AgentTurnTimeoutError) throw err;
      throw new AgentTurnTransportError(
        `lost the NATS subscription while forwarding opencode_request ${requestId} to agent run ${agentRunId} (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(deadline);
      sub.unsubscribe();
    }
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
