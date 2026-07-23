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
}

class CancelledError extends Error {
  constructor(reason?: string) {
    super(reason ?? "agent run cancelled");
  }
}

/** Distributive Omit so each union variant keeps its own fields (a plain Omit over a union keeps only common keys). */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "agent_run_id" | "seq" | "ts"> : never;

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
  let pendingAsk: { resolve: (answer: string) => void; reject: (err: Error) => void } | undefined;
  const pendingToolCalls = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();

  channel.onDown((msg: AgentDownMessage) => {
    switch (msg.type) {
      case "prompt":
        // The only prompt an active agent expects is the answer to a pending
        // ask(). Anything else (agent isn't waiting) is dropped — a fresh user
        // turn is a new AgentRun, not this one.
        if (pendingAsk) {
          const { resolve } = pendingAsk;
          pendingAsk = undefined;
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
        break;
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
        pendingAsk = { resolve, reject };
        void publishUp({ type: "reply", message: question, final: false });
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
    await publishUp({ type: "reply", message: reply.message, final: true, result: reply.result });
  } catch (err) {
    if (!(err instanceof CancelledError) && !abort.signal.aborted) {
      const code = err instanceof AgentConfigError ? "config_error" : "agent_error";
      await publishUp({ type: "failed", code, message: err instanceof Error ? err.message : String(err) });
    }
    // On cancellation the orchestrator already knows; exit quietly.
  } finally {
    await channel.close();
  }
}
