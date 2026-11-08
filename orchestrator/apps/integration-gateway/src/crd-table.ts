import * as k8s from "@kubernetes/client-node";

/** The slice of `CustomObjectsApi` a table uses -- documents the RBAC verbs it needs (list) and keeps test doubles plain objects. */
export interface CustomObjectsListApi {
  listNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<{ items?: unknown[]; metadata?: { resourceVersion?: string } }>;
}

/** The slice of `k8s.Watch` a table uses (verb: watch). */
export interface CrdWatchApi {
  watch(
    path: string,
    queryParams: Record<string, unknown>,
    onEvent: (phase: string, apiObj: unknown) => void,
    onDone: (err?: unknown) => void,
  ): Promise<{ abort(): void }>;
}

export interface CrdTableOptions {
  namespace: string;
  group: string;
  version: string;
  api: CustomObjectsListApi;
  watch: CrdWatchApi;
  /** Delay before re-listing after a watch ends or a list fails. */
  reconnectDelayMs?: number;
  log?: (msg: string) => void;
}

export type CompileOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CrdTableSpec<T> {
  /** Kind, for log lines ("EventSource"). */
  kind: string;
  plural: string;
  compile(obj: unknown): CompileOutcome<T>;
  /** Appended to the "is unusable" log line, e.g. " (its routes answer 404)". */
  unusableNote?: string;
}

const DEFAULT_RECONNECT_DELAY_MS = 2_000;

export function crdApisFromKubeConfig(kubeConfig: k8s.KubeConfig): { api: CustomObjectsListApi; watch: CrdWatchApi } {
  return {
    api: kubeConfig.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomObjectsListApi,
    watch: new k8s.Watch(kubeConfig) as unknown as CrdWatchApi,
  };
}

/**
 * List-then-watch over one namespaced custom resource, informer-style: every
 * (re)connect re-lists and REPLACES the table, then watches from the list's
 * resourceVersion. Re-listing on every reconnect (not just at startup) is what
 * makes a delete that happened while the watch was down actually disappear --
 * a bare re-watch only replays ADDED for what exists, never DELETED for what
 * vanished, so a revoked object would otherwise keep being served until restart.
 *
 * Objects are compiled once, when seen. One that fails to compile is dropped
 * (not kept at its previous version): an operator who broke an object expects
 * it to stop, not to keep running the last good copy.
 */
export class CrdTable<T> {
  private entries = new Map<string, T>();
  private listed = false;
  private stopped = false;
  private abort: { abort(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnectDelayMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly options: CrdTableOptions,
    private readonly spec: CrdTableSpec<T>,
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.log = options.log ?? ((m) => console.error(m));
  }

  get(name: string): T | undefined {
    return this.entries.get(name);
  }

  values(): IterableIterator<T> {
    return this.entries.values();
  }

  /** True once a list has landed -- before that the table is empty because it is UNKNOWN, not because nothing exists. */
  get loaded(): boolean {
    return this.listed;
  }

  /** Lists once (resolving when the first list lands, or failing if it can't), then keeps the table current in the background. */
  async start(): Promise<void> {
    this.stopped = false;
    const resourceVersion = await this.relist();
    void this.watchFrom(resourceVersion);
  }

  /** Like {@link start}, but a failed first list is logged and retried in the background instead of thrown. */
  startInBackground(): void {
    this.start().catch((err: unknown) => {
      this.log(`${this.spec.kind} list failed: ${errorText(err)}`);
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  private upsert(obj: unknown): void {
    const name = (obj as { metadata?: { name?: string } })?.metadata?.name;
    if (!name) return;
    const compiled = this.spec.compile(obj);
    if (compiled.ok) {
      this.entries.set(name, compiled.value);
    } else {
      this.entries.delete(name);
      this.log(`${this.spec.kind} ${name} is unusable${this.spec.unusableNote ?? ""}: ${compiled.error}`);
    }
  }

  private async relist(): Promise<string | undefined> {
    const { namespace, group, version } = this.options;
    const response = await this.options.api.listNamespacedCustomObject({ group, version, namespace, plural: this.spec.plural });
    const previous = this.entries;
    this.entries = new Map();
    for (const item of response.items ?? []) this.upsert(item);
    for (const name of previous.keys()) {
      if (!this.entries.has(name)) this.log(`${this.spec.kind} ${name} removed`);
    }
    this.listed = true;
    return response.metadata?.resourceVersion;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.relist()
        .then((rv) => this.watchFrom(rv))
        .catch((err: unknown) => {
          this.log(`${this.spec.kind} list failed (keeping the last known table): ${errorText(err)}`);
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
        `/apis/${group}/${version}/namespaces/${namespace}/${this.spec.plural}`,
        resourceVersion ? { resourceVersion } : {},
        (phase, obj) => {
          if (phase === "ADDED" || phase === "MODIFIED") this.upsert(obj);
          else if (phase === "DELETED") {
            const name = (obj as { metadata?: { name?: string } })?.metadata?.name;
            if (name && this.entries.delete(name)) this.log(`${this.spec.kind} ${name} removed`);
          }
        },
        (err) => {
          // Fires once per disconnect, including the apiserver's routine
          // watch timeout -- always relist + rewatch, not only on error.
          if (err && (err as { name?: string }).name !== "AbortError") {
            this.log(`${this.spec.kind} watch ended: ${errorText(err)}`);
          }
          this.scheduleReconnect();
        },
      );
    } catch (err) {
      this.log(`${this.spec.kind} watch failed to start: ${errorText(err)}`);
      this.scheduleReconnect();
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
