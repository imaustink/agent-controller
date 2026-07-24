import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { decodeEncryptionKey } from "../identity-link/store.js";

export { decodeEncryptionKey };

/** Which Claude Code credential flow produced a record -- see `ClaudeTokenRecord`'s doc. */
export type ClaudeAuthKind = "setup-token" | "login";

/**
 * A linked Claude Code credential for one subject. Exactly one of `token`
 * (the `claude setup-token` OAuth token) / `credentialsJson` (the full
 * `claude auth login --claudeai` credentials-file contents, needed for
 * Remote Control -- see `pty-login.ts`) is populated, discriminated by
 * `kind`. Both flows are kept in ONE record type (rather than two, or a
 * union) because a subject can hold both independently at once -- they're
 * stored under distinct Redis keys/channels (see `RedisClaudeTokenStore`'s
 * `keyFor`/`channelFor`) -- and every caller already has to branch on `kind`
 * to know which field to read, so a union would just move that branch to the
 * type system for no benefit.
 */
export interface ClaudeTokenRecord {
  kind: ClaudeAuthKind;
  token?: string;
  credentialsJson?: string;
  createdAt: string;
}

/**
 * Durable, subject-keyed store for per-user Claude Code credentials
 * (docs/adr/0027) -- a sibling to `identity-link/store.ts`'s
 * `IdentityLinkStore`, kept separate rather than generalized into one
 * interface: unlike a GitHub credential (one provider, `expiresAt`/
 * `refreshToken` fields), this only ever has these two shapes and one
 * "provider" -- the PTY flows that produce them are different enough from
 * GitHub's HTTP device flow that sharing an abstraction here would cost more
 * than it saves.
 *
 * `kind` defaults to `"setup-token"` on every method below so existing
 * callers written before the `login` flow existed are unaffected.
 */
export interface ClaudeTokenStore {
  get(subject: string, kind?: ClaudeAuthKind): Promise<ClaudeTokenRecord | undefined>;
  set(subject: string, record: ClaudeTokenRecord): Promise<void>;
  /** Resolves as soon as a record lands for `subject`/`kind` (via pub/sub), or `undefined` once `timeoutMs` elapses. */
  waitForCompletion(subject: string, timeoutMs: number, kind?: ClaudeAuthKind): Promise<ClaudeTokenRecord | undefined>;
  /**
   * Removes a subject's stored record for `kind` -- called when
   * agent-orchestrator sees claude-code-swe-agent report an expired/invalid
   * credential mid-run (docs/adr/0027's re-auth path), so the NEXT
   * delegation attempt's `get`/pre-flight check finds nothing linked and
   * starts a fresh flow automatically, rather than repeating the same bad
   * credential forever.
   */
  delete(subject: string, kind?: ClaudeAuthKind): Promise<void>;
}

const ALGORITHM = "aes-256-gcm";
const GCM_IV_BYTES = 12;

interface StoredRecord {
  kind: ClaudeAuthKind;
  createdAt: string;
  /** Encrypted -- packed `iv:authTag:ciphertext`, see `encryptField`/`decryptField`. Whichever of `token`/`credentialsJson` `kind` implies is present. */
  token?: string;
  credentialsJson?: string;
}

function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptField(key: Buffer, packed: string): string {
  const parts = packed.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted claude-auth field");
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64 as string, "base64");
  const authTag = Buffer.from(authTagB64 as string, "base64");
  const ciphertext = Buffer.from(ciphertextB64 as string, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Redis-backed {@link ClaudeTokenStore}, structurally identical to
 * `identity-link/store.ts`'s `RedisIdentityLinkStore` (AES-256-GCM field
 * encryption, no TTL -- a link persists until re-linked, same pub/sub
 * `waitForCompletion`) but for the `token`/`credentialsJson` fields this
 * credential has. Reuses the same `IDENTITY_LINK_ENCRYPTION_KEY` -- no new
 * encryption-key secret to provision.
 *
 * `setup-token` and `login` records live under DISTINCT Redis key/channel
 * prefixes (`claudeAuth:...` vs `claudeAuthLogin:...`, see `keyFor`) so one
 * subject can hold a live record of each kind independently, with neither
 * `set`/`delete` ever clobbering the other.
 */
export class RedisClaudeTokenStore implements ClaudeTokenStore {
  private readonly redis: Redis;
  private readonly key: Buffer;
  private readonly prefix: string;
  private readonly loginPrefix: string;

  constructor(url: string, encryptionKey: Buffer, opts: { keyPrefix?: string; loginKeyPrefix?: string } = {}) {
    if (encryptionKey.length !== 32) {
      throw new Error("Claude-auth encryption key must be exactly 32 bytes");
    }
    this.key = encryptionKey;
    this.prefix = opts.keyPrefix ?? "claudeAuth:";
    this.loginPrefix = opts.loginKeyPrefix ?? "claudeAuthLogin:";
    this.redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) => {
      console.error("RedisClaudeTokenStore connection error:", err.message);
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  private prefixFor(kind: ClaudeAuthKind): string {
    return kind === "login" ? this.loginPrefix : this.prefix;
  }

  private keyFor(subject: string, kind: ClaudeAuthKind): string {
    return `${this.prefixFor(kind)}${subject}`;
  }

  private channelFor(subject: string, kind: ClaudeAuthKind): string {
    return `${this.prefixFor(kind)}complete:${subject}`;
  }

  async delete(subject: string, kind: ClaudeAuthKind = "setup-token"): Promise<void> {
    try {
      await this.redis.del(this.keyFor(subject, kind));
    } catch (err) {
      console.error("RedisClaudeTokenStore.delete failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async get(subject: string, kind: ClaudeAuthKind = "setup-token"): Promise<ClaudeTokenRecord | undefined> {
    try {
      const raw = await this.redis.get(this.keyFor(subject, kind));
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredRecord;
      const record: ClaudeTokenRecord = { kind: stored.kind, createdAt: stored.createdAt };
      if (stored.token !== undefined) record.token = decryptField(this.key, stored.token);
      if (stored.credentialsJson !== undefined) record.credentialsJson = decryptField(this.key, stored.credentialsJson);
      return record;
    } catch (err) {
      console.error("RedisClaudeTokenStore.get failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async set(subject: string, record: ClaudeTokenRecord): Promise<void> {
    try {
      const stored: StoredRecord = { kind: record.kind, createdAt: record.createdAt };
      if (record.token !== undefined) stored.token = encryptField(this.key, record.token);
      if (record.credentialsJson !== undefined) stored.credentialsJson = encryptField(this.key, record.credentialsJson);
      await this.redis.set(this.keyFor(subject, record.kind), JSON.stringify(stored));
      await this.redis.publish(this.channelFor(subject, record.kind), "1");
    } catch (err) {
      console.error("RedisClaudeTokenStore.set failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async waitForCompletion(subject: string, timeoutMs: number, kind: ClaudeAuthKind = "setup-token"): Promise<ClaudeTokenRecord | undefined> {
    const existing = await this.get(subject, kind);
    if (existing) return existing;

    const subscriber = this.redis.duplicate();
    try {
      await subscriber.connect();
      await subscriber.subscribe(this.channelFor(subject, kind));
      const afterSubscribe = await this.get(subject, kind);
      if (afterSubscribe) return afterSubscribe;

      return await new Promise<ClaudeTokenRecord | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        subscriber.on("message", () => {
          clearTimeout(timer);
          this.get(subject, kind).then(resolve).catch(() => resolve(undefined));
        });
      });
    } catch (err) {
      console.error(
        "RedisClaudeTokenStore.waitForCompletion failed (treating as timeout):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    } finally {
      await subscriber.quit().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
