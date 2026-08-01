import { createHash } from "node:crypto";

/**
 * The one primitive every credential store in this app is built on: a durable,
 * arbitrarily-keyed record backed by a Kubernetes Secret (docs/adr/0034).
 *
 * ## Why Secrets, and why this layer exists
 *
 * These records were in Redis, and that Redis runs with `--save ""
 * --appendonly no` on an emptyDir. It restarted, every stored credential and
 * identity link in the cluster went with it, and the next turn asked a human
 * who had linked months earlier to link again. Durability of a credential is
 * not something an in-memory cache can be configured into providing credibly;
 * it is the platform's job, so these live in etcd now, backed up with the
 * cluster.
 *
 * This layer exists because the two stores that need it (`identity-link/`,
 * `claude-auth/`) have different record shapes but identical *storage*
 * concerns: subjects that aren't legal object names, a wait-for-arrival that
 * used to be Redis pub/sub, and a soft-fail posture their callers already
 * depend on. Written once here, both stores stay about their own records.
 *
 * ## Naming
 *
 * Record keys are things like `openwebui:1234` and `github:imaustink` -- a
 * colon is not legal in a DNS-1123 object name, and an IdP `sub` can exceed the
 * 253-character limit. So the object name is `<prefix>-<sha256(key)[:16]>`,
 * which sidesteps both problems at once and keeps every read an exact `get` by
 * computed name: no listing, no label-selector scan, no O(keyspace) anything.
 *
 * The tradeoff is that a Secret's name no longer tells a human whose it is, so
 * the plaintext key is stored in the record's own data (it is not itself a
 * secret -- `github:imaustink` is a username) and mirrored onto a label for
 * `kubectl get -l`. 16 hex chars is 64 bits; these keys are not
 * attacker-chosen and a collision would require two of this deployment's own
 * users, so birthday risk is not a real consideration at any plausible scale.
 */

/** The shape of a Secret as this store reads and writes it. */
interface SecretLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
}

/**
 * The slice of `CoreV1Api` this store uses, named structurally rather than
 * imported as a class -- same approach as agent-orchestrator's `SecretApiLike`
 * (apps/agent-orchestrator/src/k8s/agentrun-launcher.ts), and for the same two
 * reasons: it documents exactly which API verbs the RBAC Role has to grant, and
 * it makes a test double an object literal rather than a mocked module.
 */
export interface SecretApiLike {
  readNamespacedSecret(request: { name: string; namespace: string }): Promise<SecretLike>;
  /**
   * Only ever used by {@link SecretRecordStore.listRecords} -- a maintenance
   * sweep, never a lookup. Optional so every existing test double and any
   * caller that never sweeps keeps compiling unchanged.
   */
  listNamespacedSecret?(request: {
    namespace: string;
    labelSelector?: string;
  }): Promise<{ items?: SecretLike[] }>;
  createNamespacedSecret(request: { namespace: string; body: unknown }): Promise<SecretLike>;
  replaceNamespacedSecret(request: { name: string; namespace: string; body: unknown }): Promise<SecretLike>;
  deleteNamespacedSecret(request: { name: string; namespace: string }): Promise<unknown>;
}

/**
 * The slice of `k8s.Watch` used to notice a record arriving, so a caller
 * blocked across an OAuth browser round-trip resumes the moment the credential
 * lands instead of on the next poll. Optional everywhere: without it the store
 * still works, just on the poll interval alone.
 */
export interface WatchLike {
  watch(
    path: string,
    queryParams: Record<string, unknown>,
    onEvent: (phase: string, apiObj: unknown) => void,
    onDone: (err?: unknown) => void,
  ): Promise<{ abort(): void }>;
}

/** How often {@link SecretRecordStore.waitForRecord} re-reads while waiting. */
const WAIT_POLL_INTERVAL_MS = 5_000;

/**
 * Field holding the record's own plaintext key.
 *
 * Because the object NAME is a hash, this is the only lossless record of whose
 * credential a Secret is: the mirrored label is sanitized for Kubernetes'
 * charset (`openwebui:1234` becomes `openwebui-1234`) and truncated at 63
 * characters, so it is a search aid, not an identifier. Without this, a
 * credential that ended up under an unexpected subject -- the exact class of bug
 * ADR 0029/0031 are about -- could be seen to exist but not attributed.
 *
 * Not secret: these keys are logins and user ids. Stripped from what
 * {@link SecretRecordStore.get} returns, so a record's own fields are the only
 * thing a store sees.
 */
export const RECORD_KEY_FIELD = "_recordKey";

/** Kubernetes label values are capped at 63 chars and restricted to `[A-Za-z0-9._-]`. */
function sanitizeLabelValue(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.slice(0, 63).replace(/[^A-Za-z0-9]+$/, "") || "unknown";
}

/**
 * Whether an error from the API server means "no such object", as opposed to a
 * failure we must not silently read as an empty store.
 *
 * The distinction is load-bearing: `get` treating every error as a miss is what
 * makes a transient API-server blip look exactly like "this user never linked",
 * and ADR 0031's pre-flight acts on that answer by offering a link. So a 404
 * (and only a 404) is a miss; everything else propagates to the caller's own
 * try/catch, which logs it as a failure rather than an answer.
 *
 * Shape-tolerant on purpose: @kubernetes/client-node has moved the status code
 * between `code`, `statusCode`, and `response.statusCode` across majors, and a
 * store that silently stops recognising 404s after a dependency bump would
 * start reporting hard errors for every unlinked user.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
  return (
    candidate.code === 404 ||
    candidate.statusCode === 404 ||
    candidate.response?.statusCode === 404 ||
    (err instanceof Error && /\b404\b|not found/i.test(err.message))
  );
}

/**
 * Whether an error means "an object with that name already exists" (HTTP 409),
 * which {@link SecretRecordStore.put} turns into an update. Same shape
 * tolerance, for the same reason, as {@link isNotFoundError}.
 */
export function isConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
  return (
    candidate.code === 409 ||
    candidate.statusCode === 409 ||
    candidate.response?.statusCode === 409 ||
    (err instanceof Error && /\b409\b|already exists/i.test(err.message))
  );
}

export interface SecretRecordStoreOptions {
  /** Namespace the records live in -- the gateway's own, via the downward API. */
  namespace: string;
  /** Object-name prefix identifying this record type, e.g. `identity-link-github`. */
  namePrefix: string;
  /** Label key the plaintext record key is mirrored onto for `kubectl get -l`. */
  keyLabel: string;
  /** Labels stamped on every record, so an operator (and a cleanup sweep) can find them all. */
  commonLabels?: Record<string, string>;
  api: SecretApiLike;
  watch?: WatchLike;
  /**
   * How often {@link SecretRecordStore.waitForRecord} re-reads while waiting.
   * Defaults to {@link WAIT_POLL_INTERVAL_MS}; injectable so a test can exercise
   * the poll path without waiting out a production-sized interval.
   */
  pollIntervalMs?: number;
}

/**
 * One record type's worth of Secret-backed storage. Instantiated once per
 * (store, record kind) so each kind gets its own name prefix -- which is what
 * lets one subject hold, say, a `setup-token` and a `login` credential
 * independently, exactly as the distinct Redis key prefixes did before.
 */
export class SecretRecordStore {
  private readonly namespace: string;
  private readonly namePrefix: string;
  private readonly keyLabel: string;
  private readonly commonLabels: Record<string, string>;
  private readonly api: SecretApiLike;
  private readonly watcher: WatchLike | undefined;
  private readonly pollIntervalMs: number;

  constructor(opts: SecretRecordStoreOptions) {
    this.namespace = opts.namespace;
    this.namePrefix = opts.namePrefix;
    this.keyLabel = opts.keyLabel;
    this.commonLabels = opts.commonLabels ?? {};
    this.api = opts.api;
    this.watcher = opts.watch;
    this.pollIntervalMs = opts.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;
  }

  /** The Secret name for a record key. See this module's doc on naming. */
  nameFor(key: string): string {
    return `${this.namePrefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  }

  /**
   * Every record of this type, as `{ key, fields }`.
   *
   * This is the one label-selector scan in this file, and it is a deliberate
   * exception to the naming section's "no listing, no label-selector scan, no
   * O(keyspace) anything" -- which is a rule about the READ path, where an
   * exact `get` by computed name is both possible and required. A maintenance
   * sweep has no key to compute a name from; enumerating is the whole task.
   * `commonLabels` exists for exactly this ("so an operator -- and a cleanup
   * sweep -- can find them all"), and the selector keeps the scan scoped to
   * this record type rather than the namespace.
   *
   * Callers must treat this as maintenance-only: never on a request path, and
   * never as a way to answer "does this subject have a record" (that is `get`).
   *
   * Records whose plaintext key was not stored are skipped rather than guessed
   * at -- the object name is a one-way hash, so a record without
   * {@link RECORD_KEY_FIELD} cannot be attributed to a subject, and acting on
   * an unattributable credential is worse than leaving it alone.
   */
  async listRecords(): Promise<Array<{ key: string; fields: Record<string, string> }>> {
    if (!this.api.listNamespacedSecret) return [];
    const selector = Object.entries(this.commonLabels)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const page = await this.api.listNamespacedSecret({
      namespace: this.namespace,
      ...(selector ? { labelSelector: selector } : {}),
    });
    const out: Array<{ key: string; fields: Record<string, string> }> = [];
    for (const secret of page.items ?? []) {
      let key = "";
      const fields: Record<string, string> = {};
      for (const [field, value] of Object.entries(secret.data ?? {})) {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (field === RECORD_KEY_FIELD) key = decoded;
        else fields[field] = decoded;
      }
      if (!key || Object.keys(fields).length === 0) continue;
      out.push({ key, fields });
    }
    return out;
  }

  /**
   * Reads a record's fields, or `undefined` if there is none.
   *
   * Throws on anything that is not a 404, so the caller can tell a genuine
   * miss from a failure it must not treat as one -- see {@link isNotFoundError}.
   */
  async get(key: string): Promise<Record<string, string> | undefined> {
    let secret: SecretLike;
    try {
      secret = await this.api.readNamespacedSecret({ name: this.nameFor(key), namespace: this.namespace });
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
    const data = secret.data ?? {};
    const decoded: Record<string, string> = {};
    for (const [field, value] of Object.entries(data)) {
      // Bookkeeping, not part of the record -- see RECORD_KEY_FIELD.
      if (field === RECORD_KEY_FIELD) continue;
      decoded[field] = Buffer.from(value, "base64").toString("utf8");
    }
    // A Secret that exists but carries no fields is a corrupt record, not a
    // credential -- report it as absent so the caller re-links rather than
    // handing a half-record to a decryptor.
    return Object.keys(decoded).length > 0 ? decoded : undefined;
  }

  /**
   * Creates or replaces a record.
   *
   * Create-then-replace-on-conflict rather than a server-side apply: the
   * install base spans client-node majors whose patch content-type defaults
   * differ (the same trap documented at length in `agentrun-launcher.ts`'s
   * ownerReference patch), and create/replace behaves identically on all of
   * them.
   */
  async put(key: string, fields: Record<string, string>): Promise<void> {
    const name = this.nameFor(key);
    const body = {
      metadata: {
        name,
        labels: { ...this.commonLabels, [this.keyLabel]: sanitizeLabelValue(key) },
      },
      stringData: { ...fields, [RECORD_KEY_FIELD]: key },
    };
    try {
      await this.api.createNamespacedSecret({ namespace: this.namespace, body });
    } catch (err) {
      // Only AlreadyExists becomes an update -- the ordinary path for a re-link,
      // or a write-back persisting refreshed credentials over the copy it read.
      // Anything else (a missing RBAC rule, an unreachable API server) must
      // surface as itself: retrying it as a replace just reports the second
      // failure instead of the real one.
      if (!isConflictError(err)) throw err;
      await this.api.replaceNamespacedSecret({ name, namespace: this.namespace, body });
    }
  }

  /** Removes a record. A record that is already gone is a success, not an error. */
  async delete(key: string): Promise<void> {
    try {
      await this.api.deleteNamespacedSecret({ name: this.nameFor(key), namespace: this.namespace });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  /**
   * Resolves once a record exists for `key`, or `undefined` at `timeoutMs`.
   * Replaces the Redis pub/sub `waitForCompletion` the stores used to share.
   *
   * Watch AND poll, deliberately both rather than a fallback branch: the watch
   * makes the common case immediate (the user finishes linking in their
   * browser, the turn continues within a second), and the poll means a watch
   * that never established, silently died, or dropped an event still cannot
   * cost more than {@link WAIT_POLL_INTERVAL_MS} of latency. Belt-and-braces is
   * cheap here -- one GET every 5s for the duration of a link flow -- and the
   * alternative shape, "try watch, catch, then poll", only handles the failures
   * that announce themselves.
   *
   * Both paths resolve by re-reading through {@link get}, so a caller never
   * receives a record assembled from a watch event's payload: one read path,
   * one place decryption and validation can happen.
   */
  async waitForRecord(key: string, timeoutMs: number): Promise<Record<string, string> | undefined> {
    const immediate = await this.get(key).catch(() => undefined);
    if (immediate) return immediate;

    const name = this.nameFor(key);
    let aborted = false;
    let request: { abort(): void } | undefined;
    let poller: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    try {
      return await new Promise<Record<string, string> | undefined>((resolve) => {
        const settle = (value: Record<string, string> | undefined) => {
          if (aborted) return;
          aborted = true;
          resolve(value);
        };

        const check = () => {
          this.get(key)
            .then((found) => {
              if (found) settle(found);
            })
            .catch(() => {
              /* a failed probe is not an answer; the next one or the timeout decides */
            });
        };

        timer = setTimeout(() => settle(undefined), timeoutMs);
        poller = setInterval(check, this.pollIntervalMs);

        if (this.watcher) {
          this.watcher
            .watch(
              `/api/v1/namespaces/${this.namespace}/secrets`,
              // By name, so the API server does the filtering: this connection
              // is open for the length of a human OAuth round-trip and has no
              // business receiving every Secret event in the namespace.
              { fieldSelector: `metadata.name=${name}` },
              (phase) => {
                if (phase === "ADDED" || phase === "MODIFIED") check();
              },
              () => {
                /* watch ended -- the poll above carries on regardless */
              },
            )
            .then((req) => {
              request = req;
              // Lost the race: the record landed (or we timed out) while the
              // watch was still connecting, so nothing will ever abort it.
              if (aborted) req.abort();
            })
            .catch(() => {
              /* no watch, poll-only -- see this method's doc */
            });
          // Re-check now that a watch is being established, closing the gap
          // between the read above and the watch taking effect.
          check();
        }
      });
    } finally {
      aborted = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      request?.abort();
    }
  }
}
