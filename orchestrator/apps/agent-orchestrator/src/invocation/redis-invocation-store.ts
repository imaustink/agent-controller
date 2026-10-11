import { Redis } from "ioredis";
import type { InvocationRecord } from "../server.js";
import type { InvocationStore } from "./types.js";

export interface RedisInvocationStoreOptions {
  /** TTL in seconds. Must comfortably outlast a caller's own poll budget. */
  ttlSeconds: number;
  /** Optional key prefix; defaults to `inv:`. */
  keyPrefix?: string;
}

/**
 * Redis-backed {@link InvocationStore}, so any replica can answer any poll.
 *
 * Deliberately NOT soft-failing the way {@link RedisSessionStore} does. A lost
 * session record costs a routing hint and the next turn re-runs retrieval; a
 * lost invocation record costs the caller its answer with no way to ask again,
 * which is the exact failure this store exists to remove. So `set` surfaces
 * its error to the caller rather than logging and continuing -- writing the
 * terminal result is the last thing a turn does, and silently dropping it
 * would reintroduce the 404 by a different route.
 *
 * `get` still treats an error as a miss: the poll is a read of state that may
 * genuinely not exist yet, and a transient Redis blip should read as "not
 * ready" (the caller polls again) rather than as a hard failure.
 *
 * TTL is absolute per write rather than sliding on read, and must exceed the
 * longest poll budget any caller uses -- integration-gateway's `pollTimeoutMs`
 * defaults to 15 minutes, so the default here is well past that.
 */
export class RedisInvocationStore implements InvocationStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(url: string, opts: RedisInvocationStoreOptions) {
    this.ttlSeconds = opts.ttlSeconds;
    this.prefix = opts.keyPrefix ?? "inv:";
    this.redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) => {
      console.error("RedisInvocationStore connection error:", err.message);
    });
  }

  /** Establishes the underlying connection. Call once during startup. */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /** Lightweight connectivity check for retryWithBackoff at startup. */
  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async get(id: string): Promise<InvocationRecord | undefined> {
    try {
      const raw = await this.redis.get(`${this.prefix}${id}`);
      if (!raw) return undefined;
      return JSON.parse(raw) as InvocationRecord;
    } catch (err) {
      // A miss, not a failure: the caller polls again, and a record that
      // genuinely does not exist is indistinguishable from one Redis could
      // not serve this instant. Both mean "no answer yet".
      console.error("RedisInvocationStore.get failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async set(id: string, record: InvocationRecord): Promise<void> {
    await this.redis.set(`${this.prefix}${id}`, JSON.stringify(record), "EX", this.ttlSeconds);
  }

  /** Closes the underlying Redis connection gracefully. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
