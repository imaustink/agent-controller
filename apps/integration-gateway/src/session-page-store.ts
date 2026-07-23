import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

/** One request/response pair within a session's history. */
export interface SessionTurn {
  request: string;
  status: "pending" | "succeeded" | "failed";
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/**
 * Server-rendered "session page" (issue #81): a minimal interactive page,
 * scoped to one GitHub-issue session, that a "starting work" comment links
 * to so a caller can watch a triage run's turn history and send it follow-up
 * prompts without posting another GitHub comment. `token` is the page's
 * unguessable capability credential -- anyone holding the URL can view the
 * history and add prompts, same trust model as e.g. a calendar ICS share
 * link, so it must never be logged or embedded anywhere less private than
 * the issue comment it's posted to.
 */
export interface SessionPageEntry {
  token: string;
  sessionId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  turns: SessionTurn[];
  /**
   * Live-session tunnel info (ADR 0026), cached so a repeat page load/prompt
   * doesn't need to rediscover it. `agentRunId` is refreshed on every page
   * load from agent-orchestrator's own real-time liveness probe; `sessionId`
   * (opencode's OWN session id, e.g. "ses_abc123" -- unrelated to this
   * entry's own `sessionId` field) is discovered lazily, once, the first
   * time a prompt is actually submitted through the live tunnel.
   */
  live?: { agentRunId: string; opencodeSessionId?: string };
}

export interface CompletedOutcome {
  status: "succeeded" | "failed";
  result?: string;
  error?: string;
}

export interface AddedTurn {
  entry: SessionPageEntry;
  turnIndex: number;
}

/**
 * Keyed by `sessionId` (`github:<owner>/<repo>#<issueNumber>`, see
 * `sessionIdFor` in server.ts) for lookups from the webhook path, and by
 * `token` for lookups from the page's own routes.
 */
export interface SessionPageStore {
  /** Creates the page the first time a session is seen; a no-op returning the existing entry on every later call for the same `sessionId`. */
  getOrCreate(sessionId: string, meta: { owner: string; repo: string; issueNumber: number }): Promise<SessionPageEntry>;
  getByToken(token: string): Promise<SessionPageEntry | undefined>;
  /**
   * Appends a pending turn to an EXISTING entry. Deliberately does not
   * create one -- a plain (non-triage) issue comment/opened event has no
   * page unless/until that issue has actually been through the labeled
   * triage trigger at least once, and this must not create one just because
   * a session id happens to match.
   */
  addTurn(sessionId: string, request: string): Promise<AddedTurn | undefined>;
  completeTurn(sessionId: string, turnIndex: number, outcome: CompletedOutcome): Promise<void>;
  /**
   * Updates (or clears, passing `undefined`) the cached live-tunnel info for
   * an EXISTING entry (ADR 0026); a no-op if the entry doesn't exist.
   */
  setLive(sessionId: string, live: SessionPageEntry["live"]): Promise<void>;
}

/** 32 random bytes, base64url-encoded (43 chars, no padding) -- a bearer-capability token, not a lookup key, so it needs real entropy. */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** In-memory {@link SessionPageStore} -- fine for a single-replica/dev deployment; all pages/history are lost on restart. */
export class InMemorySessionPageStore implements SessionPageStore {
  private readonly bySessionId = new Map<string, SessionPageEntry>();
  private readonly byToken = new Map<string, SessionPageEntry>();

  async getOrCreate(
    sessionId: string,
    meta: { owner: string; repo: string; issueNumber: number },
  ): Promise<SessionPageEntry> {
    const existing = this.bySessionId.get(sessionId);
    if (existing) return existing;
    const entry: SessionPageEntry = { token: generateToken(), sessionId, ...meta, turns: [] };
    this.bySessionId.set(sessionId, entry);
    this.byToken.set(entry.token, entry);
    return entry;
  }

  async getByToken(token: string): Promise<SessionPageEntry | undefined> {
    return this.byToken.get(token);
  }

  async addTurn(sessionId: string, request: string): Promise<AddedTurn | undefined> {
    const entry = this.bySessionId.get(sessionId);
    if (!entry) return undefined;
    const turnIndex = entry.turns.push({ request, status: "pending", startedAt: new Date().toISOString() }) - 1;
    return { entry, turnIndex };
  }

  async completeTurn(sessionId: string, turnIndex: number, outcome: CompletedOutcome): Promise<void> {
    const turn = this.bySessionId.get(sessionId)?.turns[turnIndex];
    if (!turn) return;
    Object.assign(turn, outcome, { completedAt: new Date().toISOString() });
  }

  async setLive(sessionId: string, live: SessionPageEntry["live"]): Promise<void> {
    const entry = this.bySessionId.get(sessionId);
    if (!entry) return;
    entry.live = live;
  }
}

const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Redis-backed {@link SessionPageStore} so a posted page link survives a
 * gateway pod restart. Two keys per entry (`session:<sessionId>` holding the
 * full JSON blob, `token:<token>` holding just the sessionId it maps to) --
 * same soft-fail-and-log posture as `RedisIdentityLinkStore`: a Redis error
 * degrades to "page/turn temporarily unavailable", never a thrown error that
 * would take down the webhook-relay path this feature is layered on top of.
 * No distributed locking around the read-modify-write in `addTurn`/
 * `completeTurn`/`getOrCreate` -- acceptable for this store's low, mostly
 * single-writer-per-session traffic (one gateway pod driving one triage run
 * at a time per issue).
 */
export class RedisSessionPageStore implements SessionPageStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix = "sessionPage:",
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on("error", (err: Error) => {
      console.error("RedisSessionPageStore connection error:", err.message);
    });
  }

  private sessionKey(sessionId: string): string {
    return `${this.prefix}session:${sessionId}`;
  }

  private tokenKey(token: string): string {
    return `${this.prefix}token:${token}`;
  }

  private async readSession(sessionId: string): Promise<SessionPageEntry | undefined> {
    try {
      const raw = await this.redis.get(this.sessionKey(sessionId));
      return raw ? (JSON.parse(raw) as SessionPageEntry) : undefined;
    } catch (err) {
      console.error("RedisSessionPageStore.readSession failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private async write(entry: SessionPageEntry): Promise<void> {
    try {
      const raw = JSON.stringify(entry);
      await this.redis.set(this.sessionKey(entry.sessionId), raw, "EX", TTL_SECONDS);
      await this.redis.set(this.tokenKey(entry.token), entry.sessionId, "EX", TTL_SECONDS);
    } catch (err) {
      console.error("RedisSessionPageStore.write failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async getOrCreate(
    sessionId: string,
    meta: { owner: string; repo: string; issueNumber: number },
  ): Promise<SessionPageEntry> {
    const existing = await this.readSession(sessionId);
    if (existing) return existing;
    const entry: SessionPageEntry = { token: generateToken(), sessionId, ...meta, turns: [] };
    await this.write(entry);
    return entry;
  }

  async getByToken(token: string): Promise<SessionPageEntry | undefined> {
    try {
      const sessionId = await this.redis.get(this.tokenKey(token));
      return sessionId ? await this.readSession(sessionId) : undefined;
    } catch (err) {
      console.error("RedisSessionPageStore.getByToken failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async addTurn(sessionId: string, request: string): Promise<AddedTurn | undefined> {
    const entry = await this.readSession(sessionId);
    if (!entry) return undefined;
    const turnIndex = entry.turns.push({ request, status: "pending", startedAt: new Date().toISOString() }) - 1;
    await this.write(entry);
    return { entry, turnIndex };
  }

  async completeTurn(sessionId: string, turnIndex: number, outcome: CompletedOutcome): Promise<void> {
    const entry = await this.readSession(sessionId);
    const turn = entry?.turns[turnIndex];
    if (!entry || !turn) return;
    entry.turns[turnIndex] = { ...turn, ...outcome, completedAt: new Date().toISOString() };
    await this.write(entry);
  }

  async setLive(sessionId: string, live: SessionPageEntry["live"]): Promise<void> {
    const entry = await this.readSession(sessionId);
    if (!entry) return;
    entry.live = live;
    await this.write(entry);
  }

  /** Closes the underlying Redis connection gracefully. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
