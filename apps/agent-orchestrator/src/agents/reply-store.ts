import { Redis } from "ioredis";
import type { AgentTurnResult } from "./nats-agent-channel.js";

/**
 * The agent's concluding reply, keyed by AgentRun id, written BEFORE the
 * protocol's `reply_ack` is sent.
 *
 * The ack is what releases the agent's hold (docs/adr/0033): it stops
 * re-offering, finishes, and its Job goes Succeeded. Until this store existed
 * the ack was sent the instant the reply arrived in the orchestrator's memory
 * -- so it meant "I have it in memory", not "it is safe". A rollout landing
 * between the ack and the turn's outcome being written destroyed the only copy
 * of the answer: the run Succeeded, and the next turn re-attached to an agent
 * that was holding nothing and had nothing to re-offer, timing out with
 * "went silent for 30000ms".
 *
 * Writing here first inverts that. The hold is released only once the answer
 * survives this process, and a re-attaching turn reads it straight out rather
 * than waiting for a re-offer that may never come.
 *
 * Failures are NOT soft. A write that silently no-ops would ack anyway and
 * reintroduce exactly the data loss this exists to prevent -- so a failed write
 * propagates, the ack is never sent, and the agent keeps holding until someone
 * collects it.
 */
export interface AgentReplyStore {
  get(agentRunId: string): Promise<AgentTurnResult | undefined>;
  set(agentRunId: string, reply: AgentTurnResult): Promise<void>;
  delete(agentRunId: string): Promise<void>;
}

/** Default when no Redis is configured: same single-process caveat as before. */
export class InMemoryAgentReplyStore implements AgentReplyStore {
  private readonly replies = new Map<string, AgentTurnResult>();
  async get(agentRunId: string) {
    return this.replies.get(agentRunId);
  }
  async set(agentRunId: string, reply: AgentTurnResult) {
    this.replies.set(agentRunId, reply);
  }
  async delete(agentRunId: string) {
    this.replies.delete(agentRunId);
  }
}

export class RedisAgentReplyStore implements AgentReplyStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(url: string, opts: { ttlSeconds: number; keyPrefix?: string }) {
    this.ttlSeconds = opts.ttlSeconds;
    this.prefix = opts.keyPrefix ?? "areply:";
    this.redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true });
    this.redis.on("error", (err: Error) => console.error("RedisAgentReplyStore connection error:", err.message));
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async get(agentRunId: string): Promise<AgentTurnResult | undefined> {
    try {
      const raw = await this.redis.get(`${this.prefix}${agentRunId}`);
      return raw ? (JSON.parse(raw) as AgentTurnResult) : undefined;
    } catch (err) {
      // A miss: the re-attach falls back to waiting for a re-offer, which is
      // the behaviour that existed before this store.
      console.error("RedisAgentReplyStore.get failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /** Deliberately propagates failure -- see the interface doc. */
  async set(agentRunId: string, reply: AgentTurnResult): Promise<void> {
    await this.redis.set(`${this.prefix}${agentRunId}`, JSON.stringify(reply), "EX", this.ttlSeconds);
  }

  async delete(agentRunId: string): Promise<void> {
    try {
      await this.redis.del(`${this.prefix}${agentRunId}`);
    } catch {
      // Best-effort: a stale entry expires on its own, and re-reading one is
      // harmless (the turn it belongs to has already concluded).
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
