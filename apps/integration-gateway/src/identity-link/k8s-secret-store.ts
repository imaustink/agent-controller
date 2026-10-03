import {
  assertEncryptionKey,
  decryptField,
  encryptField,
} from "../credential-store/field-encryption.js";
import {
  SecretRecordStore,
  type SecretApiLike,
  type WatchLike,
} from "../credential-store/secret-record-store.js";
import type { IdentityLinkStore, LinkedCredential } from "./store.js";

/**
 * Kubernetes-Secret-backed {@link IdentityLinkStore} (docs/adr/0034), replacing
 * the Redis implementation that lost every link in the cluster when its
 * persistence-disabled pod restarted.
 *
 * Sets no expiry on its records: an account link is durable state that persists
 * until the user re-links, which is exactly the property the Redis version
 * claimed (`no TTL`) and could not actually provide.
 *
 * `token`/`refreshToken` are encrypted at rest (AES-256-GCM);
 * `githubLogin`/`expiresAt`/`refreshExpiresAt` stay plaintext so a record is
 * inspectable with `kubectl` without the key -- the same split as before, and
 * the reason `getLinkedLogin` can answer "who is this?" without touching
 * ciphertext.
 */
export class K8sSecretIdentityLinkStore implements IdentityLinkStore {
  private readonly key: Buffer;
  private readonly namespace: string;
  private readonly api: SecretApiLike;
  private readonly watcher: WatchLike | undefined;
  /**
   * One {@link SecretRecordStore} per provider, created on demand: the provider
   * belongs in the object-name prefix (so `identity-link-github-<hash>` says
   * what it is at a glance) rather than being folded into the hashed key, which
   * would make every record's name equally opaque.
   */
  private readonly perProvider = new Map<string, SecretRecordStore>();
  private readonly pollIntervalMs: number | undefined;

  constructor(
    encryptionKey: Buffer,
    opts: { namespace: string; api: SecretApiLike; watch?: WatchLike; pollIntervalMs?: number },
  ) {
    assertEncryptionKey(encryptionKey, "Identity-link");
    this.key = encryptionKey;
    this.namespace = opts.namespace;
    this.api = opts.api;
    this.watcher = opts.watch;
    this.pollIntervalMs = opts.pollIntervalMs;
  }

  private storeFor(provider: string): SecretRecordStore {
    const existing = this.perProvider.get(provider);
    if (existing) return existing;
    // The provider reaches an object name, so it is sanitized to DNS-1123 here.
    // In practice it is always `github`; this is a guard against a future
    // provider name with a character that would make every write 422.
    const slug = provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
    const created = new SecretRecordStore({
      namespace: this.namespace,
      namePrefix: `identity-link-${slug}`,
      keyLabel: "controller-agent.io/subject",
      commonLabels: {
        "controller-agent.io/credential": "identity-link",
        "controller-agent.io/provider": slug,
      },
      api: this.api,
      ...(this.watcher ? { watch: this.watcher } : {}),
      ...(this.pollIntervalMs !== undefined ? { pollIntervalMs: this.pollIntervalMs } : {}),
    });
    this.perProvider.set(provider, created);
    return created;
  }

  /** Decodes a stored record's fields back into a credential. */
  private fromFields(fields: Record<string, string>): LinkedCredential {
    return {
      githubLogin: fields.githubLogin ?? "",
      expiresAt: fields.expiresAt ?? "",
      refreshExpiresAt: fields.refreshExpiresAt || undefined,
      token: decryptField(this.key, fields.token ?? ""),
      refreshToken: fields.refreshToken ? decryptField(this.key, fields.refreshToken) : undefined,
    };
  }

  async get(provider: string, subject: string): Promise<LinkedCredential | undefined> {
    try {
      const fields = await this.storeFor(provider).get(subject);
      if (!fields) return undefined;
      return this.fromFields(fields);
    } catch (err) {
      console.error(
        "K8sSecretIdentityLinkStore.get failed (treating as miss):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  async set(provider: string, subject: string, cred: LinkedCredential): Promise<void> {
    const fields: Record<string, string> = {
      githubLogin: cred.githubLogin,
      expiresAt: cred.expiresAt,
      token: encryptField(this.key, cred.token),
    };
    // Omitted rather than written empty: a Secret field is a string, so an
    // absent refresh token and an empty one would otherwise be
    // indistinguishable on read.
    if (cred.refreshExpiresAt) fields.refreshExpiresAt = cred.refreshExpiresAt;
    if (cred.refreshToken) fields.refreshToken = encryptField(this.key, cred.refreshToken);

    const store = this.storeFor(provider);

    // Do NOT swallow a write failure. `set` is only ever called from a
    // COMPLETED OAuth flow, which has already redeemed a one-time code with
    // GitHub -- the token cannot be obtained again. A dropped write is
    // therefore a permanently lost link, not a retriable miss. Swallowing it
    // (the previous behavior) let the linker report the flow as `"complete"`
    // while nothing persisted, so the caller re-prompted on the very next
    // turn with no error logged anywhere: the silent re-link loop docs/adr/0034
    // set out to end, but reintroduced one layer up. It must surface so the
    // completion itself fails loudly instead of masquerading as success.
    await store.put(subject, fields);

    // A write the API server ACCEPTS is not yet a write that is DURABLE: a
    // mutating admission webhook can drop fields, a namespace over quota can
    // reject the object out of band, a storage backend can lie. Those are
    // indistinguishable from success at the `put` call alone, and the whole
    // ADR 0034 contract is durability -- so confirm the record is actually
    // readable back before telling the caller the account is linked. A read
    // miss here is the one failure that used to become an endless silent
    // re-prompt; turning it into a thrown error is what makes it diagnosable.
    const readBack = await store.get(subject);
    if (!readBack) {
      throw new Error(
        `identity-link ${provider} credential for subject did not persist: ` +
          `the write was accepted but read back empty, so the link is NOT durable and must not be reported complete`,
      );
    }
  }

  async waitForCompletion(
    provider: string,
    subject: string,
    timeoutMs: number,
  ): Promise<LinkedCredential | undefined> {
    try {
      const fields = await this.storeFor(provider).waitForRecord(subject, timeoutMs);
      return fields ? this.fromFields(fields) : undefined;
    } catch (err) {
      console.error(
        "K8sSecretIdentityLinkStore.waitForCompletion failed (treating as timeout):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }
}
