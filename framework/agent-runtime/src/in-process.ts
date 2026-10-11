import {
  AgentDownMessageSchema,
  AgentUpMessageSchema,
  type AgentDownMessage,
  type AgentUpMessage,
} from "@controller-agent/messaging";
import type { AgentChannel } from "./channel.js";
import { runAgent, type AgentHandler } from "./runtime.js";

/** A down-message without its envelope; the peer fills in `agent_run_id`, `seq` and `ts`. */
export type DownMessageInput = AgentDownMessage extends infer T
  ? T extends unknown
    ? Omit<T, "agent_run_id" | "seq" | "ts">
    : never
  : never;

/** Serves one tool call from the agent; the return value is the call's result. */
export type LocalTool = (input: string) => unknown | Promise<unknown>;

export interface InProcessChannelOptions {
  /** The agent run id stamped on down-messages (default `local`). */
  runId?: string;
  /**
   * Acknowledge each concluding up-message (`reply`, `failed`) as soon as it
   * arrives, the way an orchestrator does, so the agent stops holding it
   * (default true).
   */
  autoAck?: boolean;
  /** Tools the agent may call with `session.callTool()`, by name. */
  tools?: Record<string, LocalTool>;
}

/** The orchestrator's end of an in-process channel. */
export interface InProcessPeer {
  /** Every up-message the agent has published, in order. */
  readonly up: readonly AgentUpMessage[];
  /** Sends a down-message to the agent. Throws if it violates the protocol. */
  send(msg: DownMessageInput): void;
  /** Resolves with the next up-message (matching `predicate`, if given) the agent publishes. */
  next(predicate?: (msg: AgentUpMessage) => boolean): Promise<AgentUpMessage>;
  /** Registers a listener for every up-message. */
  onUp(listener: (msg: AgentUpMessage) => void): void;
  /** Resolves once the agent has closed its channel (its run is over). */
  readonly closed: Promise<void>;
}

/**
 * An {@link AgentChannel} wired straight to an in-process peer: no broker, no
 * network, no cluster. Hand `channel` to `runAgent` and drive the run from
 * `peer`.
 *
 * Messages still make a real JSON round trip and are validated against the
 * protocol schemas in both directions, so a message that would be rejected on
 * the wire is rejected here too (by throwing, so the mistake surfaces at its
 * source instead of as a silently dropped message).
 */
export function createInProcessChannel(opts: InProcessChannelOptions = {}): {
  channel: AgentChannel;
  peer: InProcessPeer;
} {
  const runId = opts.runId ?? "local";
  const autoAck = opts.autoAck ?? true;
  const up: AgentUpMessage[] = [];
  const listeners: Array<(msg: AgentUpMessage) => void> = [];
  const waiters: Array<{ predicate: (msg: AgentUpMessage) => boolean; resolve: (msg: AgentUpMessage) => void }> = [];
  let downHandler: ((msg: AgentDownMessage) => void) | undefined;
  let downSeq = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  let isClosed = false;

  const send = (msg: DownMessageInput): void => {
    const wire = JSON.parse(JSON.stringify({ ...msg, agent_run_id: runId, seq: downSeq++, ts: new Date().toISOString() }));
    const parsed = AgentDownMessageSchema.safeParse(wire);
    if (!parsed.success) {
      throw new Error(`down-message violates the agent protocol: ${parsed.error.message}`);
    }
    // Asynchronous, as on a real transport: the agent never handles a message
    // re-entrantly from inside the publish that provoked it.
    queueMicrotask(() => {
      if (!isClosed) downHandler?.(parsed.data);
    });
  };

  const serveTool = async (call: Extract<AgentUpMessage, { type: "tool_call" }>): Promise<void> => {
    const tool = opts.tools?.[call.tool];
    if (!tool) {
      send({ type: "tool_result", callId: call.callId, ok: false, error: `no local tool named "${call.tool}"` });
      return;
    }
    try {
      send({ type: "tool_result", callId: call.callId, ok: true, result: await tool(call.input) });
    } catch (err) {
      send({ type: "tool_result", callId: call.callId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const channel: AgentChannel = {
    publishUp(msg: AgentUpMessage): Promise<void> {
      const parsed = AgentUpMessageSchema.safeParse(JSON.parse(JSON.stringify(msg)));
      if (!parsed.success) {
        return Promise.reject(new Error(`up-message violates the agent protocol: ${parsed.error.message}`));
      }
      const received = parsed.data as AgentUpMessage;
      up.push(received);
      for (const listener of listeners) listener(received);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!;
        if (waiter.predicate(received)) {
          waiters.splice(i, 1);
          waiter.resolve(received);
        }
      }
      if (autoAck && (received.type === "reply" || received.type === "failed")) {
        send({ type: "reply_ack", ackSeq: received.seq });
      }
      if (received.type === "tool_call") void serveTool(received);
      return Promise.resolve();
    },
    onDown(handler: (msg: AgentDownMessage) => void): void {
      downHandler = handler;
    },
    close(): Promise<void> {
      isClosed = true;
      markClosed();
      return Promise.resolve();
    },
  };

  const peer: InProcessPeer = {
    up,
    send,
    next: (predicate = () => true) => new Promise((resolve) => waiters.push({ predicate, resolve })),
    onUp: (listener) => {
      listeners.push(listener);
    },
    closed,
  };

  return { channel, peer };
}

export interface LocalAgentOptions extends Omit<InProcessChannelOptions, "autoAck"> {
  /** The task, as an orchestrator would pass it in `AGENT_GOAL`. */
  goal: string;
  /**
   * Answers a question the agent asks (`session.ask()`). Without it, a
   * question cancels the run rather than leaving it waiting forever.
   */
  onAsk?: (question: string) => string | Promise<string>;
}

export type LocalAgentOutcome =
  | { status: "replied"; message: string; result?: unknown }
  | { status: "failed"; code: string; message: string }
  | { status: "cancelled" };

/**
 * Runs an agent handler to completion in this process, with an in-process
 * peer standing in for the orchestrator: it acknowledges replies, answers
 * questions via `onAsk`, and serves `tools`. Nothing but the handler's own
 * work leaves the process.
 *
 * ```ts
 * const { outcome } = startLocalAgent(handler, { goal: "Summarize README.md" });
 * console.log(await outcome);
 * ```
 */
export function startLocalAgent(
  handler: AgentHandler,
  opts: LocalAgentOptions,
): { peer: InProcessPeer; outcome: Promise<LocalAgentOutcome> } {
  const runId = opts.runId ?? "local";
  const { channel, peer } = createInProcessChannel({ runId, tools: opts.tools });

  peer.onUp((msg) => {
    if (msg.type !== "reply" || msg.final) return;
    if (!opts.onAsk) {
      peer.send({ type: "cancel", reason: "the agent asked a question and no onAsk handler was given" });
      return;
    }
    void Promise.resolve(opts.onAsk(msg.message)).then(
      (answer) => peer.send({ type: "prompt", message: answer }),
      (err: unknown) => peer.send({ type: "cancel", reason: err instanceof Error ? err.message : String(err) }),
    );
  });

  const outcome = runAgent(handler, {
    channel,
    config: { runId, goal: opts.goal, subjectPrefix: "agent" },
  }).then((): LocalAgentOutcome => {
    for (let i = peer.up.length - 1; i >= 0; i--) {
      const msg = peer.up[i]!;
      if (msg.type === "reply" && msg.final) return { status: "replied", message: msg.message, result: msg.result };
      if (msg.type === "failed") return { status: "failed", code: msg.code, message: msg.message };
    }
    return { status: "cancelled" };
  });

  return { peer, outcome };
}
