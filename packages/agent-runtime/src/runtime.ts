import { randomUUID } from "node:crypto";
import type { AgentDownMessage, AgentUpMessage } from "@controller-agent/messaging";
import { AgentConfigError, loadConfig, type AgentRuntimeConfig } from "./config.js";
import { NatsChannel, type AgentChannel } from "./channel.js";

/**
 * The live session handed to an agent implementation. One session spans one
 * `AgentRun` (one logical task episode): the agent acts on {@link goal},
 * narrates {@link progress}, may pause to {@link ask} the user a question
 * (human-in-the-loop), and returns its concluding reply when done. Cross-episode
 * continuity (a later, separate user turn) is a NEW AgentRun with context
 * carried by the orchestrator — not this session.
 */
export interface AgentSession {
  /** The AgentRun id. */
  readonly runId: string;
  /** The initial goal for this run. */
  readonly goal: string;
  /** Fires when the orchestrator sends `cancel` (user abandoned, timeout, etc.). */
  readonly signal: AbortSignal;
  /** Emit incremental progress narration (surfaced to the user as streaming deltas). */
  progress(message: string, opts?: { stage?: string; pct?: number }): Promise<void>;
  /** Emit a non-fatal warning. */
  warn(message: string): Promise<void>;
  /**
   * Ask the user a question and resolve with their answer. On the wire this is
   * a non-final `reply` (the question becomes the turn's assistant message);
   * the answer arrives as the next `prompt`. Rejects if the run is cancelled
   * while waiting.
   */
  ask(question: string): Promise<string>;
  /**
   * Calls a `Tool` CR named in this Agent's own `spec.toolRefs` (docs/adr/0028)
   * and resolves with its raw result. On the wire this publishes a `tool_call`
   * and awaits the correlated `tool_result` — the orchestrator re-validates
   * `name` against the launching Agent's `toolRefs` and dispatches it exactly
   * the way a Skill's tool call already is. Throws {@link ToolCallError} if
   * the tool call fails (not declared, not found, or the tool itself failed);
   * rejects with the same cancellation error as {@link ask} if the run is
   * cancelled while a call is outstanding. More than one call may be
   * outstanding at once (unlike `ask`, which allows only one pending
   * question).
   */
  callTool(name: string, input: string): Promise<unknown>;
}

/** Thrown by {@link AgentSession.callTool} when the tool call itself fails (declined, not found, or the tool errored). */
export class ToolCallError extends Error {}

/**
 * An error whose failure `code` reaches the orchestrator on the wire, instead
 * of being flattened into the generic `"agent_error"`.
 *
 * Some failures are recoverable by the orchestrator, but only if it can tell
 * them apart from ordinary task failures -- e.g. an expired linked credential,
 * where the fix is to invalidate the stored record and re-prompt the user to
 * link, not to report "the agent failed". The code is the whole point: the
 * message is for humans, the code is what the orchestrator can branch on.
 * Throw this from an {@link AgentHandler} instead of a plain `Error` when the
 * distinction matters.
 */
export class AgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentFailure";
  }
}

/** An agent's concluding reply for the run. A bare string is shorthand for `{ message }`. */
export interface AgentReply {
  /** Assistant message shown to the user. */
  message: string;
  /** Optional structured result for non-chat consumers (AgentRun status). */
  result?: unknown;
}

/** The user-supplied agent implementation: given a session, do the work and return a reply. */
export type AgentHandler = (session: AgentSession) => Promise<AgentReply | string>;

export interface RunAgentOptions {
  /** Inject a channel (tests); default connects to NATS from config. */
  channel?: AgentChannel;
  /** Inject config (tests); default reads the environment. */
  config?: AgentRuntimeConfig;
  /** Override {@link REPLY_ACK_RETRY_MS} (tests). */
  replyAckRetryMs?: number;
  /** Override {@link REPLY_ACK_TIMEOUT_MS} (tests). */
  replyAckTimeoutMs?: number;
}

class CancelledError extends Error {
  constructor(reason?: string) {
    super(reason ?? "agent run cancelled");
  }
}

/** Distributive Omit so each union variant keeps its own fields (a plain Omit over a union keeps only common keys). */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "agent_run_id" | "seq" | "ts"> : never;

/**
 * How often to re-offer an unacked concluding message, and how long to keep
 * offering it before giving up and exiting.
 *
 * This is the agent's half of `reply_ack` (see the protocol's doc comment):
 * core NATS drops anything published while the orchestrator has no live
 * subscription, and the concluding message is the only one whose loss turns a
 * successful run into a failed-looking turn. The Job pod outlives an
 * orchestrator rollout, so simply holding the answer and re-offering it lets a
 * replacement orchestrator reattach and collect it.
 *
 * 10 minutes because the gap being covered is an orchestrator pod replacement
 * (seconds) plus however long it takes something to re-drive the turn -- for a
 * chat conversation, the user's next message. Past that the answer is stale
 * enough that holding a pod open for it is the worse trade.
 */
const REPLY_ACK_RETRY_MS = 10_000;
const REPLY_ACK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Boots a sub-agent: connects the channel, announces `ready`, runs `handler`
 * against a {@link AgentSession}, and publishes the terminal `reply`/`failed`.
 * Resolves once the channel is drained — the caller should then exit the
 * process. Never throws for normal agent failures (those become a `failed`
 * up-message); only re-throws config/connection errors that mean the pod can't
 * function at all.
 */
export async function runAgent(handler: AgentHandler, opts: RunAgentOptions = {}): Promise<void> {
  const config = opts.config ?? loadConfig();
  const channel = opts.channel ?? (await NatsChannel.connect(config));

  let seq = 0;
  const publishUp = (msg: WithoutEnvelope<AgentUpMessage>): Promise<void> =>
    channel.publishUp({
      ...msg,
      agent_run_id: config.runId,
      seq: seq++,
      ts: new Date().toISOString(),
    } as AgentUpMessage);

  const abort = new AbortController();
  let pendingAsk:
    | { resolve: (answer: string) => void; reject: (err: Error) => void; seq: number }
    | undefined;

  /**
   * Concluding messages currently being held for an ack, keyed by `seq`. A map
   * rather than a single slot because two can legitimately overlap: a question
   * (`ask()`, a non-final `reply`) is still being held when its answer arrives
   * and the agent goes on to publish its final reply. With one slot the older
   * hold would never be woken and would keep re-offering a question the
   * conversation had already moved past.
   */
  const holds = new Map<number, { acked: boolean; done: boolean; wake?: () => void }>();

  /** Stops holding `seq` without an ack — the message became moot on its own terms. */
  const releaseHold = (seq: number): void => {
    const hold = holds.get(seq);
    if (!hold) return;
    hold.done = true;
    hold.wake?.();
  };

  /**
   * Publishes a message whose loss would break the turn (`reply` of either
   * finality, `failed`) and holds it until the orchestrator acks that exact
   * `seq`, re-offering it every {@link REPLY_ACK_RETRY_MS} until then. Every
   * re-offer reuses the ORIGINAL envelope, `seq` included, so the orchestrator
   * sees a duplicate as one rather than as a second reply.
   *
   * Resolves either way — an unacked message is logged and abandoned rather
   * than holding the Job's pod open indefinitely. Cancellation and
   * {@link releaseHold} both end the wait early.
   */
  const publishHeld = async (
    msg: WithoutEnvelope<AgentUpMessage>,
    // Callers that must know the seq BEFORE the hold resolves (ask(), which
    // has to record it on `pendingAsk` so the answer can release the hold)
    // allocate it themselves and pass it in.
    allocatedSeq: number = seq++,
  ): Promise<number> => {
    const envelope = {
      ...msg,
      agent_run_id: config.runId,
      seq: allocatedSeq,
      ts: new Date().toISOString(),
    } as AgentUpMessage;
    const retryMs = opts.replyAckRetryMs ?? config.replyAckRetryMs ?? REPLY_ACK_RETRY_MS;
    const timeoutMs = opts.replyAckTimeoutMs ?? config.replyAckTimeoutMs ?? REPLY_ACK_TIMEOUT_MS;
    // Holding disabled (AGENT_REPLY_ACK_TIMEOUT_MS=0): publish once and move on,
    // exactly as this did before `reply_ack` existed.
    if (timeoutMs === 0) {
      await channel.publishUp(envelope);
      return envelope.seq;
    }
    const deadline = Date.now() + timeoutMs;
    const hold = { acked: false, done: false } as { acked: boolean; done: boolean; wake?: () => void };
    // Registered BEFORE the first publish so an ack can never arrive with
    // nowhere to land (a fast orchestrator can ack before we would otherwise
    // have parked).
    holds.set(envelope.seq, hold);

    // A publish failure is precisely the case this loop exists for -- the
    // connection is down, so nothing could have received it. Log and let the
    // next attempt try again rather than abandoning the message.
    const offer = async (): Promise<void> => {
      try {
        await channel.publishUp(envelope);
      } catch (err) {
        console.error(
          `[agent-runtime] failed to publish ${envelope.type} (seq ${envelope.seq}), will retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    try {
      await offer();
      while (!hold.acked && !hold.done && !abort.signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            hold.wake = undefined;
            resolve();
          }, retryMs);
          hold.wake = () => {
            clearTimeout(timer);
            hold.wake = undefined;
            resolve();
          };
        });
        if (hold.acked || hold.done || abort.signal.aborted || Date.now() >= deadline) break;
        await offer();
      }
      if (!hold.acked && !hold.done && !abort.signal.aborted) {
        console.error(
          `[agent-runtime] ${envelope.type} (seq ${envelope.seq}) was never acknowledged within ${timeoutMs}ms; ` +
            "giving up on it -- the turn that launched this run may report it as unfinished even though the work is done",
        );
      }
      return envelope.seq;
    } finally {
      holds.delete(envelope.seq);
    }
  };

  const pendingToolCalls = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();

  channel.onDown((msg: AgentDownMessage) => {
    switch (msg.type) {
      case "prompt":
        // The only prompt an active agent expects is the answer to a pending
        // ask(). Anything else (agent isn't waiting) is dropped — a fresh user
        // turn is a new AgentRun, not this one.
        if (pendingAsk) {
          const { resolve, seq: askSeq } = pendingAsk;
          pendingAsk = undefined;
          // The answer proves the question was received even if its ack never
          // was, and re-offering an already-answered question would surface a
          // stale message to the next turn.
          releaseHold(askSeq);
          resolve(msg.message);
        }
        break;
      case "tool_result": {
        const pending = pendingToolCalls.get(msg.callId);
        if (!pending) break; // unknown/already-settled callId — nothing to resolve
        pendingToolCalls.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new ToolCallError(msg.error ?? `tool call ${msg.callId} failed`));
        break;
      }
      case "cancel":
        if (!abort.signal.aborted) abort.abort(new CancelledError(msg.reason));
        if (pendingAsk) {
          const { reject } = pendingAsk;
          pendingAsk = undefined;
          reject(new CancelledError(msg.reason));
        }
        for (const [callId, pending] of pendingToolCalls) {
          pendingToolCalls.delete(callId);
          pending.reject(new CancelledError(msg.reason));
        }
        // Nobody is waiting for these any more; wake the holds now rather than
        // letting each sit out its retry interval before noticing the abort.
        for (const seqHeld of [...holds.keys()]) releaseHold(seqHeld);
        break;
      case "reply_ack": {
        // An ack for a seq we are not holding is normal and ignorable: a
        // re-offer that crossed with the ack for the original produces a second
        // ack after the hold is gone.
        const hold = holds.get(msg.ackSeq);
        if (!hold) break;
        hold.acked = true;
        hold.wake?.();
        break;
      }
      case "signal":
        // Extension point; no built-in signals yet.
        break;
    }
  });

  const session: AgentSession = {
    runId: config.runId,
    goal: config.goal,
    signal: abort.signal,
    progress: (message, o) => publishUp({ type: "progress", message, stage: o?.stage, pct: o?.pct }),
    warn: (message) => publishUp({ type: "warning", message }),
    ask: (question) =>
      new Promise<string>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(new CancelledError());
          return;
        }
        // Held like a final reply: a dropped question strands the conversation
        // just as badly as a dropped answer -- the user sees a failed turn while
        // this agent sits waiting for an answer to something nobody ever saw.
        // The seq is allocated up front so the answer can release the hold.
        const askSeq = seq++;
        pendingAsk = { resolve, reject, seq: askSeq };
        void publishHeld({ type: "reply", message: question, final: false }, askSeq);
      }),
    callTool: (tool, input) =>
      new Promise<unknown>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(new CancelledError());
          return;
        }
        const callId = randomUUID();
        pendingToolCalls.set(callId, { resolve, reject });
        void publishUp({ type: "tool_call", callId, tool, input });
      }),
  };

  await publishUp({ type: "ready" });

  try {
    const res = await handler(session);
    const reply: AgentReply = typeof res === "string" ? { message: res } : res;
    await publishHeld({ type: "reply", message: reply.message, final: true, result: reply.result });
  } catch (err) {
    if (!(err instanceof CancelledError) && !abort.signal.aborted) {
      // A handler-supplied `code` wins (see AgentFailure). Matched by `name`
      // as well as `instanceof`, so an AgentFailure that crossed a duplicated-
      // module/realm boundary still reports its code -- but NOT by `code`
      // alone, or every stray `ENOENT`/`ECONNREFUSED` from Node's own errors
      // would start leaking onto the wire as a failure code.
      const declared = err instanceof AgentFailure || (err as { name?: unknown } | null)?.name === "AgentFailure"
        ? (err as { code?: unknown }).code
        : undefined;
      const code =
        typeof declared === "string" && declared
          ? declared
          : err instanceof AgentConfigError
            ? "config_error"
            : "agent_error";
      await publishHeld({ type: "failed", code, message: err instanceof Error ? err.message : String(err) });
    }
    // On cancellation the orchestrator already knows; exit quietly.
  } finally {
    await channel.close();
  }
}
