import { randomUUID } from "node:crypto";
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import {
  AgentUpMessageSchema,
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

export class AgentTurnTimeoutError extends Error {}
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
   */
  awaitReply(
    agentRunId: string,
    opts?: {
      timeoutMs?: number;
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

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — an agent may be waiting on a human.
/** Default bound for a forwarded `opencode_request` -- as long as an ordinary agent turn might take. */
const DEFAULT_OPENCODE_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

export class NatsAgentChannel implements AgentOrchestratorChannel {
  private readonly codec = JSONCodec<unknown>();
  private seq = 0;

  private constructor(
    private readonly nc: NatsConnection,
    private readonly subjectPrefix: string,
  ) {}

  static async connect(natsUrl: string, subjectPrefix = "agent"): Promise<NatsAgentChannel> {
    const nc = await connect({ servers: natsUrl });
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
      timeoutMs?: number;
      onProgress?: (stage: string | undefined, message: string) => void;
      onToolCall?: (call: { callId: string; tool: string; input: string }) => void;
    } = {},
  ): Promise<AgentTurnResult> {
    const { up } = agentSubjects(agentRunId, this.subjectPrefix);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sub = this.nc.subscribe(up, { timeout: timeoutMs });
    const narration: string[] = [];

    try {
      for await (const m of sub) {
        const msg = this.decode(m.data);
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
            sub.unsubscribe();
            return { message: msg.message, final: msg.final, result: msg.result, narration };
          case "failed":
            sub.unsubscribe();
            throw new AgentTurnFailedError(msg.code, msg.message);
          case "tool_call":
            opts.onToolCall?.({ callId: msg.callId, tool: msg.tool, input: msg.input });
            break;
          default:
            break; // opencode_event/opencode_response/session_idle/session_ended (ADR 0026) irrelevant here -- see subscribeLive/forwardOpencodeRequest
        }
      }
      throw new AgentTurnTimeoutError(`agent run ${agentRunId} produced no reply within ${timeoutMs}ms`);
    } catch (err) {
      // nats.js surfaces a subscription timeout as a rejected iterator, not a
      // thrown value from within the loop — normalize it to the same error.
      if (err instanceof AgentTurnFailedError || err instanceof AgentTurnTimeoutError) throw err;
      throw new AgentTurnTimeoutError(`agent run ${agentRunId} produced no reply within ${timeoutMs}ms`);
    }
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
    // response can never be missed by a late subscription.
    const sub = this.nc.subscribe(up, { timeout: timeoutMs });

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
      throw new AgentTurnTimeoutError(`agent run ${agentRunId} did not respond to opencode_request ${requestId} within ${timeoutMs}ms`);
    } finally {
      sub.unsubscribe();
    }
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
