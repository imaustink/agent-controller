import { connect, JSONCodec, type NatsConnection } from "nats";
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
   * `narration` but do not resolve). Call this BEFORE triggering whatever
   * makes the agent respond (launching the AgentRun, or `sendPrompt`) so a
   * fast reply can never be missed by a late subscription.
   */
  awaitReply(agentRunId: string, opts?: { timeoutMs?: number }): Promise<AgentTurnResult>;
  /** Sends a follow-up user turn to an already-running agent (HITL continuation, or a fresh follow-up turn). */
  sendPrompt(agentRunId: string, message: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — an agent may be waiting on a human.

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

  async awaitReply(agentRunId: string, opts: { timeoutMs?: number } = {}): Promise<AgentTurnResult> {
    const { up } = agentSubjects(agentRunId, this.subjectPrefix);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sub = this.nc.subscribe(up, { timeout: timeoutMs });
    const narration: string[] = [];

    try {
      for await (const m of sub) {
        let decoded: unknown;
        try {
          decoded = this.codec.decode(m.data);
        } catch {
          continue; // ignore non-JSON garbage on the subject
        }
        const parsed = AgentUpMessageSchema.safeParse(decoded);
        if (!parsed.success) continue;
        const msg: AgentUpMessage = parsed.data;

        switch (msg.type) {
          case "ready":
            break;
          case "progress":
            narration.push(msg.message);
            break;
          case "warning":
            narration.push(`Warning: ${msg.message}`);
            break;
          case "reply":
            sub.unsubscribe();
            return { message: msg.message, final: msg.final, result: msg.result, narration };
          case "failed":
            sub.unsubscribe();
            throw new AgentTurnFailedError(msg.code, msg.message);
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

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
