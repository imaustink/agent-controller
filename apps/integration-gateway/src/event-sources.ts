import * as k8s from "@kubernetes/client-node";
import {
  compileExpression,
  type CompiledExpression,
  type CronSource,
  type EventSourceResource,
  type WebhookSource,
} from "@controller-agent/event-triggers";

/**
 * The gateway's view of `EventSource` CRs (ADR 0048, docs/event-triggers.md
 * §1): how events ARRIVE and how far they are trusted. The gateway reads only
 * this kind (plus the Secrets it references); `EventTrigger`s are the
 * orchestrator's business.
 *
 * A source is compiled once, when it is seen, so a request never compiles CEL
 * or re-validates the spec. A source that fails to compile is UNUSABLE -- its
 * route answers 404 exactly as if it did not exist, and the reason is logged.
 * That is the fail-closed choice: a half-understood source (say, a sender
 * block whose `loginFrom` doesn't compile) must not run as if it had no sender
 * gate at all.
 *
 * The gateway does not gate on the CR's `Ready` condition. core-controller
 * computes that independently (and its cron Readiness depends on its own tick
 * configuration), and serving or refusing a route is decided by whether THIS
 * process could compile the source.
 */

export const EVENT_SOURCE_PLURAL = "eventsources";

export interface CompiledSender {
  provider: "github";
  loginFrom: CompiledExpression;
  isBotFrom?: CompiledExpression;
  repositoryFrom?: CompiledExpression;
  /** Default true: bot-authored events are dropped (self-trigger guard). */
  dropBots: boolean;
}

export type CompiledEventSource =
  | { name: string; kind: "webhook"; webhook: WebhookSource; sender?: CompiledSender }
  | { name: string; kind: "cron"; cron: CronSource };

export type CompileSourceResult = { ok: true; source: CompiledEventSource } | { ok: false; error: string };

const VERIFY_SCHEMES = new Set(["hmacSha256", "slackV0", "bearer"]);

function compileField(field: string, expr: string | undefined): { ok: true; expression: CompiledExpression } | { ok: false; error: string } {
  if (typeof expr !== "string" || !expr.trim()) return { ok: false, error: `${field} is empty` };
  const compiled = compileExpression(expr);
  return compiled.ok ? compiled : { ok: false, error: `${field}: ${compiled.error}` };
}

/** Validates and compiles one EventSource CR. Mirrors the CRD's own CEL rules, so a CR that slipped past them (or an older CRD) still fails closed here. */
export function compileEventSource(resource: EventSourceResource): CompileSourceResult {
  const name = resource?.metadata?.name;
  if (!name) return { ok: false, error: "missing metadata.name" };
  const spec = resource.spec ?? {};
  if (Boolean(spec.webhook) === Boolean(spec.cron)) {
    return { ok: false, error: "exactly one of spec.webhook / spec.cron must be set" };
  }

  if (spec.cron) {
    if (spec.sender) return { ok: false, error: "spec.sender is only valid with spec.webhook" };
    return { ok: true, source: { name, kind: "cron", cron: spec.cron } };
  }

  const webhook = spec.webhook!;
  const verify = webhook.verify;
  if (!verify || !VERIFY_SCHEMES.has(verify.scheme)) {
    return { ok: false, error: `spec.webhook.verify.scheme must be one of ${[...VERIFY_SCHEMES].join(", ")}` };
  }
  if (!verify.secretRef?.name || !verify.secretRef?.key) {
    return { ok: false, error: "spec.webhook.verify.secretRef.name and .key are required" };
  }
  if (verify.scheme === "hmacSha256" && !verify.header) {
    return { ok: false, error: "spec.webhook.verify.header is required for hmacSha256" };
  }

  let sender: CompiledSender | undefined;
  if (spec.sender) {
    if (spec.sender.provider !== "github") {
      return { ok: false, error: `spec.sender.provider ${JSON.stringify(spec.sender.provider)} is not supported (only "github")` };
    }
    const login = compileField("spec.sender.loginFrom", spec.sender.loginFrom);
    if (!login.ok) return login;
    let isBot: CompiledExpression | undefined;
    if (spec.sender.isBotFrom !== undefined) {
      const c = compileField("spec.sender.isBotFrom", spec.sender.isBotFrom);
      if (!c.ok) return c;
      isBot = c.expression;
    }
    let repository: CompiledExpression | undefined;
    if (spec.sender.repositoryFrom !== undefined) {
      const c = compileField("spec.sender.repositoryFrom", spec.sender.repositoryFrom);
      if (!c.ok) return c;
      repository = c.expression;
    }
    sender = {
      provider: "github",
      loginFrom: login.expression,
      ...(isBot ? { isBotFrom: isBot } : {}),
      ...(repository ? { repositoryFrom: repository } : {}),
      dropBots: spec.sender.dropBots ?? true,
    };
  }

  return { ok: true, source: { name, kind: "webhook", webhook, ...(sender ? { sender } : {}) } };
}

/** What the HTTP routes need: a usable source by name, or nothing. */
export interface EventSourceLookup {
  get(name: string): CompiledEventSource | undefined;
}

/** A fixed set of sources -- tests, and a deployment with no CRD namespace (empty). */
export class StaticEventSourceRegistry implements EventSourceLookup {
  private readonly sources = new Map<string, CompiledEventSource>();

  constructor(resources: EventSourceResource[] = [], log: (msg: string) => void = (m) => console.error(m)) {
    for (const r of resources) {
      const compiled = compileEventSource(r);
      if (compiled.ok) this.sources.set(compiled.source.name, compiled.source);
      else log(`EventSource ${r?.metadata?.name ?? "<unnamed>"} is unusable: ${compiled.error}`);
    }
  }

  get(name: string): CompiledEventSource | undefined {
    return this.sources.get(name);
  }
}

/** The slice of `CustomObjectsApi` the registry uses -- documents the RBAC verbs it needs (list) and keeps test doubles plain objects. */
export interface CustomObjectsListApi {
  listNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<{ items?: unknown[]; metadata?: { resourceVersion?: string } }>;
}

/** The slice of `k8s.Watch` the registry uses (verb: watch). */
export interface CrdWatchApi {
  watch(
    path: string,
    queryParams: Record<string, unknown>,
    onEvent: (phase: string, apiObj: unknown) => void,
    onDone: (err?: unknown) => void,
  ): Promise<{ abort(): void }>;
}

export interface CrdEventSourceRegistryOptions {
  namespace: string;
  group: string;
  version: string;
  api: CustomObjectsListApi;
  watch: CrdWatchApi;
  /** Delay before re-listing after a watch ends or a list fails. */
  reconnectDelayMs?: number;
  log?: (msg: string) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 2_000;

/**
 * List-then-watch over `eventsources` in one namespace, informer-style: every
 * (re)connect re-lists and REPLACES the table, then watches from the list's
 * resourceVersion. Re-listing on every reconnect (not just at startup) is what
 * makes a delete that happened while the watch was down actually disappear --
 * a bare re-watch only replays ADDED for what exists, never DELETED for what
 * vanished, so a revoked source would otherwise keep serving until restart.
 */
export class CrdEventSourceRegistry implements EventSourceLookup {
  private sources = new Map<string, CompiledEventSource>();
  private stopped = false;
  private abort: { abort(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnectDelayMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly options: CrdEventSourceRegistryOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.log = options.log ?? ((m) => console.error(m));
  }

  static fromKubeConfig(
    kubeConfig: k8s.KubeConfig,
    opts: { namespace: string; group: string; version: string },
  ): CrdEventSourceRegistry {
    return new CrdEventSourceRegistry({
      ...opts,
      api: kubeConfig.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomObjectsListApi,
      watch: new k8s.Watch(kubeConfig) as unknown as CrdWatchApi,
    });
  }

  get(name: string): CompiledEventSource | undefined {
    return this.sources.get(name);
  }

  /** Lists once (resolving when the first list lands, or failing if it can't), then keeps the table current in the background. */
  async start(): Promise<void> {
    this.stopped = false;
    const resourceVersion = await this.relist();
    void this.watchFrom(resourceVersion);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  private upsert(obj: unknown): void {
    const resource = obj as EventSourceResource;
    const name = resource?.metadata?.name;
    if (!name) return;
    const compiled = compileEventSource(resource);
    if (compiled.ok) {
      this.sources.set(name, compiled.source);
    } else {
      // Dropped, not kept at its previous version: an operator who broke a
      // source expects it to stop, not to keep running the last good copy.
      this.sources.delete(name);
      this.log(`EventSource ${name} is unusable (its routes answer 404): ${compiled.error}`);
    }
  }

  private async relist(): Promise<string | undefined> {
    const { namespace, group, version } = this.options;
    const response = await this.options.api.listNamespacedCustomObject({ group, version, namespace, plural: EVENT_SOURCE_PLURAL });
    const previous = this.sources;
    this.sources = new Map();
    for (const item of response.items ?? []) this.upsert(item);
    for (const name of previous.keys()) {
      if (!this.sources.has(name)) this.log(`EventSource ${name} removed`);
    }
    return response.metadata?.resourceVersion;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.relist()
        .then((rv) => this.watchFrom(rv))
        .catch((err: unknown) => {
          this.log(`EventSource list failed (keeping the last known table): ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleReconnect();
        });
    }, this.reconnectDelayMs);
    this.timer.unref?.();
  }

  private async watchFrom(resourceVersion: string | undefined): Promise<void> {
    if (this.stopped) return;
    const { namespace, group, version } = this.options;
    try {
      this.abort = await this.options.watch.watch(
        `/apis/${group}/${version}/namespaces/${namespace}/${EVENT_SOURCE_PLURAL}`,
        resourceVersion ? { resourceVersion } : {},
        (phase, obj) => {
          if (phase === "ADDED" || phase === "MODIFIED") this.upsert(obj);
          else if (phase === "DELETED") {
            const name = (obj as EventSourceResource)?.metadata?.name;
            if (name && this.sources.delete(name)) this.log(`EventSource ${name} removed`);
          }
        },
        (err) => {
          // Fires once per disconnect, including the apiserver's routine
          // watch timeout -- always relist + rewatch, not only on error.
          if (err && (err as { name?: string }).name !== "AbortError") {
            this.log(`EventSource watch ended: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.scheduleReconnect();
        },
      );
    } catch (err) {
      this.log(`EventSource watch failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
    }
  }
}

/** The slice of `CoreV1Api` the secret reader uses (verb: get on secrets). */
export interface SecretReadApi {
  readNamespacedSecret(request: { name: string; namespace: string }): Promise<{ data?: Record<string, string> }>;
}

export interface SecretKeyReaderOptions {
  api: SecretReadApi;
  namespace: string;
  /** How long a found value is reused before re-reading (rotation lag). */
  ttlMs?: number;
  /** How long a MISSING value is remembered -- short, so creating the Secret takes effect quickly, but non-zero so a flood of unsigned requests can't turn into a flood of API reads. */
  negativeTtlMs?: number;
  /** Minimum age of a cached read before a `refresh: true` re-reads it. */
  minRefreshIntervalMs?: number;
  now?: () => number;
}

/** What the server needs from a secret source -- {@link SecretKeyReader} in production, a map in tests. */
export interface SecretLookup {
  get(name: string, key: string, opts?: { refresh?: boolean }): Promise<string | undefined>;
}

const DEFAULT_SECRET_TTL_MS = 30_000;
const DEFAULT_SECRET_MIN_REFRESH_MS = 2_000;
const DEFAULT_SECRET_NEGATIVE_TTL_MS = 5_000;

/**
 * Reads one key of a Secret through the API (not a mounted volume: sources
 * come and go at runtime, and mounting every source's Secret would mean a
 * redeploy per source -- the thing ADR 0048 set out to remove). Short TTL
 * cache so a webhook burst is one read, and a rotation lands within the TTL.
 *
 * `get` returns `undefined` for a missing Secret, missing key or an
 * unreadable one; every caller treats that as "verification fails" (401) or
 * "don't sign" -- never as an empty secret.
 */
export class SecretKeyReader implements SecretLookup {
  private readonly cache = new Map<string, { value: string | undefined; readAt: number; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SecretKeyReaderOptions) {
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_SECRET_MIN_REFRESH_MS;
    this.ttlMs = options.ttlMs ?? DEFAULT_SECRET_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_SECRET_NEGATIVE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * `refresh: true` bypasses a cached value -- used to re-check once after a
   * credential mismatch, so a just-rotated Secret is accepted without waiting
   * out the TTL or restarting the pod. Bounded by `minRefreshIntervalMs` per
   * key, so a stream of bad credentials can't turn into a stream of API reads.
   */
  async get(name: string, key: string, opts: { refresh?: boolean } = {}): Promise<string | undefined> {
    const cacheKey = `${name}\u0000${key}`;
    const hit = this.cache.get(cacheKey);
    const now = this.now();
    if (hit && hit.expiresAt > now) {
      const recentlyRead = now - hit.readAt < this.minRefreshIntervalMs;
      if (!opts.refresh || recentlyRead) return hit.value;
    }
    let value: string | undefined;
    try {
      const secret = await this.options.api.readNamespacedSecret({ name, namespace: this.options.namespace });
      const encoded = secret.data?.[key];
      const decoded = encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
      value = decoded ? decoded : undefined;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 404) {
        // Not cached: a transient API failure should not pin "no secret" for
        // the negative TTL. Still fails closed for this request.
        console.error(`Secret ${name}/${key} unreadable: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      value = undefined;
    }
    const readAt = this.now();
    this.cache.set(cacheKey, { value, readAt, expiresAt: readAt + (value === undefined ? this.negativeTtlMs : this.ttlMs) });
    return value;
  }
}
