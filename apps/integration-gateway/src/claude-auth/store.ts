import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { decodeEncryptionKey } from "../identity-link/store.js";

export { decodeEncryptionKey };

/** A linked Claude Code OAuth credential for one subject (the chat user who ran through `claude setup-token`). */
export interface ClaudeTokenRecord {
  token: string;
  createdAt: string;
}

/**
 * Durable, subject-keyed store for per-user Claude Code OAuth tokens
 * (docs/adr/0027) -- a sibling to `identity-link/store.ts`'s
 * `IdentityLinkStore`, kept separate rather than generalized into one
 * interface: unlike a GitHub credential (one provider, `expiresAt`/
 * `refreshToken` fields), this only ever has one shape and one "provider" --
 * the PTY `setup-token` flow that produces it is different enough from
 * GitHub's HTTP device flow that sharing an abstraction here would cost more
 * than it saves.
 */
export interface ClaudeTokenStore {
  get(subject: string): Promise<ClaudeTokenRecord | undefined>;
  set(subject: string, record: ClaudeTokenRecord): Promise<void>;
  /** Resolves as soon as a token lands for `subject` (via pub/sub), or `undefined` once `timeoutMs` elapses. */
  waitForCompletion(subject: string, timeoutMs: number): Promise<ClaudeTokenRecord | undefined>;
  /**
   * Removes a subject's stored token -- called when agent-orchestrator sees
   * claude-code-swe-agent report an expired/invalid credential mid-run
   * (docs/adr/0027's re-auth path), so the NEXT delegation attempt's
   * `get`/pre-flight check finds nothing linked and starts a fresh
   * `setup-token` flow automatically, rather than repeating the same bad
   * token forever.
   */
  delete(subject: string): Promise<void>;
}

const ALGORITHM = "aes-256-gcm";
const GCM_IV_BYTES = 12;

interface StoredRecord {
  createdAt: string;
  token: string;
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
 * `waitForCompletion`) but for the single `token` field this credential has.
 * Reuses the same `IDENTITY_LINK_ENCRYPTION_KEY` -- no new encryption-key
 * secret to provision, kept in its own Redis key namespace
 * (`claudeAuth:...`) so the two stores never collide.
 */
export class RedisClaudeTokenStore implements ClaudeTokenStore {
  private readonly redis: Redis;
  private readonly key: Buffer;
  private readonly prefix: string;

  constructor(url: string, encryptionKey: Buffer, opts: { keyPrefix?: string } = {}) {
    if (encryptionKey.length !== 32) {
      throw new Error("Claude-auth encryption key must be exactly 32 bytes");
    }
    this.key = encryptionKey;
    this.prefix = opts.keyPrefix ?? "claudeAuth:";
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

  private keyFor(subject: string): string {
    return `${this.prefix}${subject}`;
  }

  private channelFor(subject: string): string {
    return `${this.prefix}complete:${subject}`;
  }

  async delete(subject: string): Promise<void> {
    try {
      await this.redis.del(this.keyFor(subject));
    } catch (err) {
      console.error("RedisClaudeTokenStore.delete failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async get(subject: string): Promise<ClaudeTokenRecord | undefined> {
    try {
      const raw = await this.redis.get(this.keyFor(subject));
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredRecord;
      return { createdAt: stored.createdAt, token: decryptField(this.key, stored.token) };
    } catch (err) {
      console.error("RedisClaudeTokenStore.get failed (treating as miss):", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async set(subject: string, record: ClaudeTokenRecord): Promise<void> {
    try {
      const stored: StoredRecord = { createdAt: record.createdAt, token: encryptField(this.key, record.token) };
      await this.redis.set(this.keyFor(subject), JSON.stringify(stored));
      await this.redis.publish(this.channelFor(subject), "1");
    } catch (err) {
      console.error("RedisClaudeTokenStore.set failed (ignored):", err instanceof Error ? err.message : String(err));
    }
  }

  async waitForCompletion(subject: string, timeoutMs: number): Promise<ClaudeTokenRecord | undefined> {
    const existing = await this.get(subject);
    if (existing) return existing;

    const subscriber = this.redis.duplicate();
    try {
      await subscriber.connect();
      await subscriber.subscribe(this.channelFor(subject));
      const afterSubscribe = await this.get(subject);
      if (afterSubscribe) return afterSubscribe;

      return await new Promise<ClaudeTokenRecord | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        subscriber.on("message", () => {
          clearTimeout(timer);
          this.get(subject).then(resolve).catch(() => resolve(undefined));
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
