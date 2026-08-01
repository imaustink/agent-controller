import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption for stored credentials, shared by every credential
 * store in this app (`identity-link/`, `claude-auth/`).
 *
 * Hoisted here when those stores moved from Redis to Kubernetes Secrets
 * (docs/adr/0034): the two had carried byte-identical copies of
 * `encryptField`/`decryptField` since the second one was written, and the move
 * would have made that three. `decodeEncryptionKey` already lived in one and
 * was re-exported by the other, which is the same seam pointing the same way.
 *
 * ## Why encrypt at all, now that these live in Secrets
 *
 * Because a Kubernetes Secret is only as confidential as the cluster makes it:
 * etcd encryption-at-rest is opt-in, and a backup of etcd is a backup of every
 * Secret in plaintext without it. Encrypting the token fields under a key held
 * only in this app's environment means the durable copy is useless on its own,
 * so durability and confidentiality stay independent properties. It also keeps
 * the threat model unchanged from the Redis era rather than quietly relaxing it
 * as a side effect of a storage migration.
 */

const ENCRYPTION_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

export { ENCRYPTION_KEY_BYTES };

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
 * Encrypts one secret string field with AES-256-GCM, hand-rolled with
 * `node:crypto` -- same no-new-dependency precedent as
 * `packages/github-app-auth/src/githubApp.ts`'s JWT signing. Ciphertext is
 * packed as a single `iv:authTag:ciphertext` base64 string so it drops into a
 * JSON blob as an ordinary string field.
 */
export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptField(key: Buffer, packed: string): string {
  const parts = packed.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted credential field");
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64 as string, "base64");
  const authTag = Buffer.from(authTagB64 as string, "base64");
  const ciphertext = Buffer.from(ciphertextB64 as string, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Guard shared by every store constructor, so they all reject a bad key identically. */
export function assertEncryptionKey(key: Buffer, label: string): void {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(`${label} encryption key must be exactly ${ENCRYPTION_KEY_BYTES} bytes`);
  }
}
