import { Redis } from "ioredis";
import type { SessionRecord, SessionStore } from "./types.js";

export interface RedisSessionStoreOptions {
  /** Sliding TTL in seconds: each `set` resets the expiry. */
  ttlSeconds: number;
  /** Optional key prefix; defaults to `sess:`. */
  keyPrefix?: string;
}

/**
 * Redis-backed {@link SessionStore} adapter (docs/adr/0016). Uses
 * ioredis with a lazy connection so startup is non-blocking; the first
 * real operation establishes the connection. All errors are treated as
 * soft failures — a Redis outage degrades to stateless per-turn skill
 * selection (the same behaviour as running without a session store), never
 * a hard crash, consistent with the "never correctness-critical" contract
 * of {@link SessionRecord}.
 *
 * TTL is sliding per `set`: every write resets the expiry. Reads do NOT
 * extend the TTL, so a conversation idle for longer than `ttlSeconds` must
 * restart skill selection on the next turn.
 */
export class RedisSessionStore implements SessionStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(url: string, opts: RedisSessionStoreOptions) {
    this.ttlSeconds = opts.ttlSeconds;
    this.prefix = opts.keyPrefix ?? "sess:";
    this.redis = new Redis(url, {
      // Do not buffer commands while disconnected — fail immediately so the
      // caller gets a soft miss rather than a queue that drains unpredictably.
      enableOfflineQueue: false,
      // Limit retries inside a single command to 0 (we handle retry at the
      // store boundary in retryWithBackoff at startup; per-command retries
      // would just hide transient errors we want to observe).
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) => {
      console.error("RedisSessionStore connection error:", err.message);
    });
  }

  /** Establishes the underlying connection. Call once during startup (wrapped in retryWithBackoff). */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /** Lightweight connectivity check for retryWithBackoff at startup. */
  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    try {
      const raw = await this.redis.get(`${this.prefix}${sessionId}`);
      if (!raw) return undefined;
      return JSON.parse(raw) as SessionRecord;
    } catch (err) {
      console.error(
        "RedisSessionStore.get failed (treating as miss):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  async set(sessionId: string, record: Omit<SessionRecord, "updatedAt">): Promise<void> {
    try {
      const full: SessionRecord = { ...record, updatedAt: Date.now() };
      await this.redis.set(`${this.prefix}${sessionId}`, JSON.stringify(full), "EX", this.ttlSeconds);
    } catch (err) {
      console.error(
        "RedisSessionStore.set failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Closes the underlying Redis connection gracefully. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
