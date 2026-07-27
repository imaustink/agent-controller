import type { SecretApiLike, WatchLike } from "../secret-record-store.js";

/**
 * An in-memory stand-in for the slice of `CoreV1Api` the credential stores use,
 * shared by their tests.
 *
 * Deliberately reproduces the API server's ERROR shapes, not just its happy
 * path: a store's correctness here is mostly about which failures it treats as
 * "no such credential" and which it refuses to (see `isNotFoundError`'s doc), so
 * a double that resolved `undefined` instead of throwing a 404 would test the
 * opposite of what matters.
 */

/** Mirrors @kubernetes/client-node's error shape closely enough for the store's status detection. */
export class FakeApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

interface StoredSecret {
  metadata: { name: string; labels?: Record<string, string> };
  data: Record<string, string>;
}

export class FakeSecretApi implements SecretApiLike {
  /** Keyed by `<namespace>/<name>`, so a test can assert on exactly what was written. */
  readonly secrets = new Map<string, StoredSecret>();
  /** Every call, in order -- lets a test assert create-then-replace rather than two creates. */
  readonly calls: string[] = [];
  /** Set to make the next call of a given kind fail, for the non-404 paths. */
  failWith: { verb: "read" | "create" | "replace" | "delete"; error: unknown } | undefined;

  private maybeFail(verb: "read" | "create" | "replace" | "delete"): void {
    if (this.failWith?.verb === verb) {
      const { error } = this.failWith;
      this.failWith = undefined;
      throw error;
    }
  }

  private static decode(body: unknown): StoredSecret {
    const secret = body as { metadata: { name: string; labels?: Record<string, string> }; stringData?: Record<string, string> };
    const data: Record<string, string> = {};
    for (const [field, value] of Object.entries(secret.stringData ?? {})) {
      data[field] = Buffer.from(value, "utf8").toString("base64");
    }
    return { metadata: secret.metadata, data };
  }

  async readNamespacedSecret(request: { name: string; namespace: string }): Promise<StoredSecret> {
    this.calls.push(`read:${request.name}`);
    this.maybeFail("read");
    const found = this.secrets.get(`${request.namespace}/${request.name}`);
    if (!found) throw new FakeApiError(404, `secrets "${request.name}" not found`);
    return found;
  }

  async createNamespacedSecret(request: { namespace: string; body: unknown }): Promise<StoredSecret> {
    const secret = FakeSecretApi.decode(request.body);
    this.calls.push(`create:${secret.metadata.name}`);
    this.maybeFail("create");
    const key = `${request.namespace}/${secret.metadata.name}`;
    if (this.secrets.has(key)) {
      throw new FakeApiError(409, `secrets "${secret.metadata.name}" already exists`);
    }
    this.secrets.set(key, secret);
    return secret;
  }

  async replaceNamespacedSecret(request: { name: string; namespace: string; body: unknown }): Promise<StoredSecret> {
    this.calls.push(`replace:${request.name}`);
    this.maybeFail("replace");
    const secret = FakeSecretApi.decode(request.body);
    this.secrets.set(`${request.namespace}/${request.name}`, secret);
    return secret;
  }

  async deleteNamespacedSecret(request: { name: string; namespace: string }): Promise<unknown> {
    this.calls.push(`delete:${request.name}`);
    this.maybeFail("delete");
    const key = `${request.namespace}/${request.name}`;
    if (!this.secrets.delete(key)) throw new FakeApiError(404, `secrets "${request.name}" not found`);
    return {};
  }

  /** Every raw record body written, for asserting no plaintext token was stored. */
  rawFor(name: string): string {
    for (const [key, secret] of this.secrets) {
      if (key.endsWith(`/${name}`)) return JSON.stringify(secret.data);
    }
    return "";
  }

  /** The single stored record, when a test wrote exactly one. */
  onlyName(): string {
    const names = [...this.secrets.values()].map((s) => s.metadata.name);
    if (names.length !== 1) throw new Error(`expected exactly one stored Secret, found ${names.length}`);
    return names[0]!;
  }
}

/** A `k8s.Watch` double whose events a test fires by hand. */
export class FakeWatch implements WatchLike {
  private handlers: ((phase: string, obj: unknown) => void)[] = [];
  aborted = 0;
  /** Set to make `watch()` reject, exercising the poll-only path. */
  failToStart = false;

  async watch(
    _path: string,
    _queryParams: Record<string, unknown>,
    onEvent: (phase: string, apiObj: unknown) => void,
  ): Promise<{ abort(): void }> {
    if (this.failToStart) throw new Error("watch unavailable");
    this.handlers.push(onEvent);
    return {
      abort: () => {
        this.aborted += 1;
      },
    };
  }

  emit(phase = "ADDED"): void {
    for (const handler of this.handlers) handler(phase, {});
  }

  get watching(): number {
    return this.handlers.length;
  }
}
