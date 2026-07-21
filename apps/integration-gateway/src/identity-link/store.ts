import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Redis } from "ioredis";

/** A linked external-identity credential for one `(provider, subject)` pair. */
export interface LinkedCredential {
  githubLogin: string;
  token: string;
  expiresAt: string;
  refreshToken: string | undefined;
  refreshExpiresAt: string | undefined;
}

/** Durable, subject-keyed store for linked external-identity credentials. */
export interface IdentityLinkStore {
  get(provider: string, subject: string): Promise<LinkedCredential | undefined>;
  set(provider: string, subject: string, cred: LinkedCredential): Promise<void>;
}

const ENCRYPTION_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

/** On-disk (in Redis) shape: secret fields are replaced with `iv:authTag:ciphertext`, everything else stays plaintext. */
interface StoredRecord {
  githubLogin: string;
  expiresAt: string;
  refreshExpiresAt: string | undefined;
  token: string;
  refreshToken: string | undefined;
}

/**
 * Decodes `IDENTITY_LINK_ENCRYPTION_KEY` into a 32-byte AES-256 key. Accepts
 * either base64 or hex; whichever decodes to exactly 32 bytes wins. Throws
 * synchronously at construction (not lazily on first use) so a
 * misconfiguration fails startup immediately rather than the first time a
 * user attempts to link.
 */
export function decodeEncryptionKey(raw: string): Buffer {
  const base64 = Buffer.from(raw, "base64");
  if (base64.length === ENCRYPTION_KEY_BYTES) return base64;
  const hex = /^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.alloc(0);
  if (hex.length === ENCRYPTION_KEY_BYTES) return hex;
  throw new Error(
    `IDENTITY_LINK_ENCRYPTION_KEY must decode (base64 or hex) to exactly ${ENCRYPTION_KEY_BYTES} bytes for AES-256-GCM`,
  );
}

/**
 * Encrypts/decrypts secret string fields (the GitHub token/refresh token) at
 * rest with AES-256-GCM, hand-rolled with `node:crypto` -- same
 * no-new-dependency precedent as `packages/github-app-auth/src/githubApp.ts`'s
 * JWT signing. Ciphertext is packed as a single `iv:authTag:ciphertext`
 * base64 string so it drops into the JSON blob as an ordinary string field.
 */
function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptField(key: Buffer, packed: string): string {
  const parts = packed.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted identity-link field");
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64 as string, "base64");
  const authTag = Buffer.from(authTagB64 as string, "base64");
  const ciphertext = Buffer.from(ciphertextB64 as string, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Redis-backed {@link IdentityLinkStore}, modeled closely on
 * `apps/agent-orchestrator/src/session/redis-session-store.ts` (same ioredis
 * lazy-connect pattern, soft-fail-and-log posture). Unlike `RedisSessionStore`
 * this sets **no TTL** on its keys -- an account link is durable state that
 * persists until the user re-links, not ephemeral conversation state.
 *
 * `token`/`refreshToken` are encrypted at rest (AES-256-GCM); `githubLogin`/
 * `expiresAt`/`refreshExpiresAt` are not secret and stay plaintext so they're
 * inspectable without decryption.
 */
export class RedisIdentityLinkStore implements IdentityLinkStore {
  private readonly redis: Redis;
  private readonly key: Buffer;
  private readonly prefix: string;

  constructor(url: string, encryptionKey: Buffer, opts: { keyPrefix?: string } = {}) {
    if (encryptionKey.length !== ENCRYPTION_KEY_BYTES) {
      throw new Error(`Identity-link encryption key must be exactly ${ENCRYPTION_KEY_BYTES} bytes`);
    }
    this.key = encryptionKey;
    this.prefix = opts.keyPrefix ?? "identityLink:";
    this.redis = new Redis(url, {
      // Do not buffer commands while disconnected -- fail immediately so the
      // caller gets a soft miss rather than a queue that drains unpredictably.
      enableOfflineQueue: false,
      // Per-command retries are disabled; retry happens at the store
      // boundary (retryWithBackoff at startup) instead.
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    this.redis.on("error", (err: Error) => {
      console.error("RedisIdentityLinkStore connection error:", err.message);
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

  private keyFor(provider: string, subject: string): string {
    return `${this.prefix}${provider}:${subject}`;
  }

  async get(provider: string, subject: string): Promise<LinkedCredential | undefined> {
    try {
      const raw = await this.redis.get(this.keyFor(provider, subject));
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredRecord;
      return {
        githubLogin: stored.githubLogin,
        expiresAt: stored.expiresAt,
        refreshExpiresAt: stored.refreshExpiresAt,
        token: decryptField(this.key, stored.token),
        refreshToken: stored.refreshToken ? decryptField(this.key, stored.refreshToken) : undefined,
      };
    } catch (err) {
      console.error(
        "RedisIdentityLinkStore.get failed (treating as miss):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  async set(provider: string, subject: string, cred: LinkedCredential): Promise<void> {
    try {
      const stored: StoredRecord = {
        githubLogin: cred.githubLogin,
        expiresAt: cred.expiresAt,
        refreshExpiresAt: cred.refreshExpiresAt,
        token: encryptField(this.key, cred.token),
        refreshToken: cred.refreshToken ? encryptField(this.key, cred.refreshToken) : undefined,
      };
      // No TTL/EX here -- an account link persists indefinitely until re-linked.
      await this.redis.set(this.keyFor(provider, subject), JSON.stringify(stored));
    } catch (err) {
      console.error(
        "RedisIdentityLinkStore.set failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Closes the underlying Redis connection gracefully. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
