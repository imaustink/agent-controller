import { Redis } from "ioredis";

/**
 * The durable half of the deterministic label-removal fix.
 *
 * Trigger-label removal (ai-triage / ai-review) used to be an in-process
 * `finally` hung off a DETACHED background promise that the gateway holds for
 * the whole turn (up to `GATEWAY_POLL_TIMEOUT_MS`). If the gateway pod
 * restarts or is OOM-killed mid-turn, that `finally` never runs and nothing
 * else ever retries -- the label is stranded forever, so a re-apply emits no
 * `labeled` event and the issue/PR can never be re-triaged by hand. That was
 * the "label removal only works ~3/4 of the time" bug.
 *
 * The fix is an outbox: the moment a label-triggered run starts, the gateway
 * records a {@link PendingLabelRemoval} in a DURABLE store (Redis in
 * production). The normal in-process `finally` removes the label AND clears the
 * record. A record that is still present therefore means its `finally` never
 * completed -- the pod died, or GitHub kept rejecting the delete past its own
 * bounded retry. {@link LabelReconciler} sweeps those leftovers (on startup and
 * periodically), confirms the run is no longer live, and removes the label
 * idempotently.
 *
 * This deliberately does NOT enumerate GitHub ("every issue carrying the
 * label") -- it only reconciles labels THIS gateway applied and recorded, which
 * is both cheaper and exactly the set that can be stranded.
 */
export interface PendingLabelRemoval {
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
  /** The `github:<owner>/<repo>#<n>` session id, used to probe the run's liveness/terminal state. */
  sessionId: string;
  /** Epoch ms the record was written -- the sweep ignores anything younger than its grace window. */
  recordedAt: number;
}

/**
 * Durable record of label removals still owed. Keyed by `(sessionId, label)`:
 * a session's triage and review labels are independent, and a re-trigger on the
 * same issue reuses the same session id, so the pair is the natural identity.
 *
 * Every method is best-effort at the call site (the webhook relay must not fail
 * because this store is briefly unavailable), so implementations soft-fail and
 * log rather than throw -- the same posture as the session-page store.
 */
export interface PendingLabelStore {
  /** Idempotently records a label whose removal is owed once its run finishes. */
  record(entry: PendingLabelRemoval): Promise<void>;
  /** Removes a record once its label has actually been taken off GitHub. A no-op if already gone. */
  clear(sessionId: string, label: string): Promise<void>;
  /** Every record still owed -- the reconciler's work list. */
  list(): Promise<PendingLabelRemoval[]>;
}

function key(sessionId: string, label: string): string {
  return `${sessionId}\u0000${label}`;
}

/** In-memory {@link PendingLabelStore} -- heals a mid-turn throw within one process, but NOT across a restart (use Redis for that). */
export class InMemoryPendingLabelStore implements PendingLabelStore {
  private readonly entries = new Map<string, PendingLabelRemoval>();

  async record(entry: PendingLabelRemoval): Promise<void> {
    this.entries.set(key(entry.sessionId, entry.label), entry);
  }

  async clear(sessionId: string, label: string): Promise<void> {
    this.entries.delete(key(sessionId, label));
  }

  async list(): Promise<PendingLabelRemoval[]> {
    return [...this.entries.values()];
  }
}

const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Redis-backed {@link PendingLabelStore} so an owed removal survives a gateway
 * pod restart -- which is the whole point, since an in-process restart is
 * exactly when the `finally` is lost. Soft-fails and logs on any Redis error,
 * same as {@link RedisSessionPageStore}: a transient Redis outage must never
 * take down the webhook relay this is layered onto. Records carry a TTL as a
 * long backstop so a permanently unreconcilable entry (e.g. the issue was
 * deleted) cannot accumulate forever.
 */
export class RedisPendingLabelStore implements PendingLabelStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix = "pendingLabel:",
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on("error", (err: Error) => {
      console.error("RedisPendingLabelStore connection error:", err.message);
    });
  }

  private redisKey(sessionId: string, label: string): string {
    return `${this.prefix}${key(sessionId, label)}`;
  }

  async record(entry: PendingLabelRemoval): Promise<void> {
    try {
      await this.redis.set(this.redisKey(entry.sessionId, entry.label), JSON.stringify(entry), "EX", TTL_SECONDS);
    } catch (err) {
      console.error("RedisPendingLabelStore.record failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async clear(sessionId: string, label: string): Promise<void> {
    try {
      await this.redis.del(this.redisKey(sessionId, label));
    } catch (err) {
      console.error("RedisPendingLabelStore.clear failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async list(): Promise<PendingLabelRemoval[]> {
    try {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      if (keys.length === 0) return [];
      const raws = await this.redis.mget(keys);
      return raws
        .filter((r): r is string => typeof r === "string")
        .map((r) => JSON.parse(r) as PendingLabelRemoval);
    } catch (err) {
      console.error("RedisPendingLabelStore.list failed (treating as empty):", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export interface LabelReconcilerOptions {
  store: PendingLabelStore;
  /**
   * Whether the run behind a recorded label has reached a TERMINAL state and
   * so is safe to strip the label from. In production this is wired to the
   * orchestrator's real-time liveness probe (`checkLive`): a run THIS gateway
   * recorded that is no longer live has either finished or died, and in both
   * cases no in-process `finally` will ever remove its label. Kept injectable
   * so the orchestrator-reachable terminal signal can evolve without changing
   * the sweep, and so tests can drive it exactly.
   */
  isRunTerminal: (sessionId: string) => Promise<boolean>;
  /** Idempotent label removal -- {@link GithubReplyClient.removeIssueLabel} (404 == success, retried internally). */
  removeLabel: (owner: string, repo: string, issueNumber: number, label: string) => Promise<void>;
  /** How often the periodic sweep runs. */
  intervalMs?: number;
  /**
   * How old a record must be before the sweep will act on it. Guards two races:
   * a run between `/invoke` accept and its pod becoming live (would read as
   * "not live" = terminal and be stripped prematurely), and a transient
   * `checkLive` error that soft-fails to not-live. A legitimately owed removal
   * is only ever LATE, never wrong, so waiting out the grace costs nothing.
   */
  graceMs?: number;
  onError?: (error: unknown) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * Periodically (and on startup) removes trigger labels whose in-process
 * `finally` never ran -- the durable self-heal for a gateway that restarted or
 * OOM'd mid-turn. See the module header for the outbox design.
 */
export class LabelReconciler {
  private readonly store: PendingLabelStore;
  private readonly isRunTerminal: (sessionId: string) => Promise<boolean>;
  private readonly removeLabel: (owner: string, repo: string, issueNumber: number, label: string) => Promise<void>;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: LabelReconcilerOptions) {
    this.store = options.store;
    this.isRunTerminal = options.isRunTerminal;
    this.removeLabel = options.removeLabel;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.onError = options.onError ?? ((e) => console.error(e));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One pass over the owed records. For each one past its grace window whose run
   * is terminal, removes the label and clears the record. Idempotent and safe
   * to run concurrently with a live turn's own `finally`: a double removal is a
   * 404 (success) and clearing an already-cleared record is a no-op. Never
   * throws -- a per-entry failure is reported and the entry is simply retried on
   * the next sweep.
   */
  async sweepOnce(): Promise<void> {
    let entries: PendingLabelRemoval[];
    try {
      entries = await this.store.list();
    } catch (error) {
      this.onError(error);
      return;
    }
    const cutoff = this.now() - this.graceMs;
    for (const entry of entries) {
      if (entry.recordedAt > cutoff) continue; // still within grace -- let the turn's own finally handle it
      try {
        if (!(await this.isRunTerminal(entry.sessionId))) continue; // run still alive -- not orphaned
        await this.removeLabel(entry.owner, entry.repo, entry.issueNumber, entry.label);
        await this.store.clear(entry.sessionId, entry.label);
      } catch (error) {
        // Leave the record in place so the next sweep retries it.
        this.onError(error);
      }
    }
  }

  /** Runs one sweep immediately (startup self-heal) and then on `intervalMs`. Overlapping ticks are skipped. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive just for the sweep.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweepOnce();
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
