import type { SessionRecord, SessionStore } from "./types.js";

export interface InMemorySessionStoreOptions {
  /** Sliding idle TTL in milliseconds; entries untouched for longer are dropped on next access. */
  ttlMs: number;
  /** Hard cap on stored sessions; the least-recently-updated entry is evicted when exceeded. */
  maxEntries: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-memory {@link SessionStore} adapter (docs/adr/0012). Deliberately
 * simple: a Map with sliding-TTL expiry checked lazily on access plus a
 * max-entries cap with least-recently-updated eviction — no timers to leak.
 * Suitable for the chart's default single-replica deployment only; sessions
 * are best-effort routing hints, so losing one (restart, eviction, a second
 * replica) degrades harmlessly to per-turn skill selection.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;

  constructor(private readonly opts: InMemorySessionStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(sessionId: string): Promise<SessionRecord | undefined> {
    const record = this.sessions.get(sessionId);
    if (!record) return Promise.resolve(undefined);
    if (this.now() - record.updatedAt > this.opts.ttlMs) {
      this.sessions.delete(sessionId);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(record);
  }

  set(sessionId: string, record: Omit<SessionRecord, "updatedAt">): Promise<void> {
    // Delete-then-set keeps Map insertion order = least-recently-updated
    // order, so eviction below can just take the first key.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, { ...record, updatedAt: this.now() });
    while (this.sessions.size > this.opts.maxEntries) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return Promise.resolve();
  }
}
