import { createHash, randomBytes } from "node:crypto";
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
import type { ClaudeAuthKind, ClaudeTokenRecord, ClaudeTokenStore } from "./store.js";

/**
 * Kubernetes-Secret-backed {@link ClaudeTokenStore} (docs/adr/0034), replacing
 * the Redis implementation whose pod restart cost every user in the cluster
 * their Claude authorization.
 *
 * Structurally the sibling of `identity-link/k8s-secret-store.ts`: same
 * {@link SecretRecordStore} primitive, same AES-256-GCM field encryption under
 * the same `IDENTITY_LINK_ENCRYPTION_KEY` (no new secret to provision), for the
 * `token`/`credentialsJson` fields this credential has instead.
 *
 * `setup-token` and `login` records live under DISTINCT object-name prefixes
 * (see {@link storeFor}) so one subject can hold a live record of each kind
 * independently, with neither `set`/`delete` ever clobbering the other -- the
 * property the distinct Redis key prefixes used to provide.
 */
export class K8sSecretClaudeTokenStore implements ClaudeTokenStore {
  private readonly key: Buffer;
  private readonly credentialStores = new Map<ClaudeAuthKind, SecretRecordStore>();
  private readonly grants: SecretRecordStore;

  constructor(
    encryptionKey: Buffer,
    private readonly opts: { namespace: string; api: SecretApiLike; watch?: WatchLike; pollIntervalMs?: number },
  ) {
    assertEncryptionKey(encryptionKey, "Claude-auth");
    this.key = encryptionKey;
    this.grants = new SecretRecordStore({
      namespace: opts.namespace,
      namePrefix: "claude-writeback-grant",
      keyLabel: "controller-agent.io/grant",
      commonLabels: { "controller-agent.io/credential": "claude-writeback-grant" },
      api: opts.api,
    });
  }

  private storeFor(kind: ClaudeAuthKind): SecretRecordStore {
    const existing = this.credentialStores.get(kind);
    if (existing) return existing;
    const created = new SecretRecordStore({
      namespace: this.opts.namespace,
      namePrefix: kind === "login" ? "claude-auth-login" : "claude-auth-setup-token",
      keyLabel: "controller-agent.io/subject",
      commonLabels: {
        "controller-agent.io/credential": "claude-auth",
        "controller-agent.io/claude-auth-kind": kind,
      },
      api: this.opts.api,
      ...(this.opts.watch ? { watch: this.opts.watch } : {}),
      ...(this.opts.pollIntervalMs !== undefined ? { pollIntervalMs: this.opts.pollIntervalMs } : {}),
    });
    this.credentialStores.set(kind, created);
    return created;
  }

  private fromFields(fields: Record<string, string>, kind: ClaudeAuthKind): ClaudeTokenRecord {
    const record: ClaudeTokenRecord = {
      kind: (fields.kind as ClaudeAuthKind | undefined) ?? kind,
      createdAt: fields.createdAt ?? "",
    };
    if (fields.token !== undefined) record.token = decryptField(this.key, fields.token);
    if (fields.credentialsJson !== undefined) {
      record.credentialsJson = decryptField(this.key, fields.credentialsJson);
    }
    return record;
  }

  async get(subject: string, kind: ClaudeAuthKind = "setup-token"): Promise<ClaudeTokenRecord | undefined> {
    try {
      const fields = await this.storeFor(kind).get(subject);
      return fields ? this.fromFields(fields, kind) : undefined;
    } catch (err) {
      console.error(
        "K8sSecretClaudeTokenStore.get failed (treating as miss):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  /**
   * Every subject holding a record of `kind`, via a label-selector scan.
   *
   * Unlike `get`/`set`/`delete` above, this deliberately does NOT swallow its
   * error. Those soft-fail because their caller has a sensible response to "no
   * answer" (offer a link, skip the write). A sweep that reads a failed list as
   * an empty one would silently do nothing forever, which is precisely the
   * outcome it exists to prevent -- so the caller is told and can say so.
   */
  async listSubjects(kind: ClaudeAuthKind = "setup-token"): Promise<string[]> {
    return (await this.storeFor(kind).listRecords()).map((r) => r.key);
  }

  async set(subject: string, record: ClaudeTokenRecord): Promise<void> {
    try {
      const fields: Record<string, string> = { kind: record.kind, createdAt: record.createdAt };
      if (record.token !== undefined) fields.token = encryptField(this.key, record.token);
      if (record.credentialsJson !== undefined) {
        fields.credentialsJson = encryptField(this.key, record.credentialsJson);
      }
      await this.storeFor(record.kind).put(subject, fields);
    } catch (err) {
      console.error(
        "K8sSecretClaudeTokenStore.set failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async delete(subject: string, kind: ClaudeAuthKind = "setup-token"): Promise<void> {
    try {
      await this.storeFor(kind).delete(subject);
    } catch (err) {
      console.error(
        "K8sSecretClaudeTokenStore.delete failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Ordering here is load-bearing and carried over verbatim from the Redis
   * implementation: read the source, refuse to clobber the destination, write,
   * READ BACK, and only then delete the source.
   *
   * `set` swallows its own errors by design, so an unverified delete could drop
   * the human's only credential on a transient write failure -- the one outcome
   * strictly worse than the extra login this method exists to avoid.
   */
  async rekey(
    fromSubject: string,
    toSubject: string,
    kind: ClaudeAuthKind = "setup-token",
  ): Promise<"moved" | "not-found" | "occupied"> {
    if (fromSubject === toSubject) return "occupied";
    const record = await this.get(fromSubject, kind);
    if (!record) return "not-found";
    if (await this.get(toSubject, kind)) return "occupied";
    await this.set(toSubject, record);
    const landed = await this.get(toSubject, kind);
    if (!landed) return "not-found";
    await this.delete(fromSubject, kind);
    return "moved";
  }

  /**
   * Only the token's SHA-256 is the record key, so the durable copy can't be
   * replayed as a bearer token by anything that can read the namespace -- the
   * same reason a server stores password hashes rather than passwords. The
   * plaintext exists only in the mint response and the run's environment.
   */
  async createWritebackToken(subject: string, ttlSeconds: number): Promise<{ token: string; secretName: string }> {
    const token = randomBytes(32).toString("base64url");
    const hashed = createHash("sha256").update(token).digest("hex");
    // The TTL is recorded as given, not clamped to a minimum. Its predecessor
    // clamped because Redis rejects a non-positive `EX`; here expiry is enforced
    // in `resolveWritebackToken`, so clamping would quietly turn "grant nothing"
    // into "grant a second" -- and `expiresAt` should mean what the caller asked
    // for.
    const expiresAt = new Date(Date.now() + Math.floor(ttlSeconds) * 1000).toISOString();
    // Fails loudly (unlike `set`/`delete`, which swallow): the caller injects
    // the returned token into an AgentRun, and a grant the API server never
    // accepted would look valid to the run and 401 on every write-back attempt.
    await this.grants.put(hashed, { subject, expiresAt });
    return { token, secretName: this.grants.nameFor(hashed) };
  }

  async resolveWritebackToken(token: string): Promise<string | undefined> {
    if (!token) return undefined;
    try {
      const fields = await this.grants.get(createHash("sha256").update(token).digest("hex"));
      if (!fields?.subject) return undefined;
      // Expiry is enforced HERE, not by the store: Kubernetes has no TTL on a
      // Secret, so a grant whose object outlives its window (the owning
      // AgentRun not yet swept, or never created because the launch failed)
      // must still stop authorizing write-backs at the time it was minted for.
      if (fields.expiresAt && Date.parse(fields.expiresAt) <= Date.now()) return undefined;
      return fields.subject;
    } catch (err) {
      console.error(
        "K8sSecretClaudeTokenStore.resolveWritebackToken failed (treating as invalid):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  async waitForCompletion(
    subject: string,
    timeoutMs: number,
    kind: ClaudeAuthKind = "setup-token",
  ): Promise<ClaudeTokenRecord | undefined> {
    try {
      const fields = await this.storeFor(kind).waitForRecord(subject, timeoutMs);
      return fields ? this.fromFields(fields, kind) : undefined;
    } catch (err) {
      console.error(
        "K8sSecretClaudeTokenStore.waitForCompletion failed (treating as timeout):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }
}
