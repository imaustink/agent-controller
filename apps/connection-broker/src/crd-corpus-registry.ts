import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type WatchCrdFn } from "./k8s/crd-watcher.js";
import {
  toBinding,
  type ConnectionCustomResource,
  type CorpusCustomResource,
  type SecretReader,
} from "./corpus-resource.js";
import type { CorpusBinding, CorpusRegistry } from "./registry.js";

export const CORPUS_PLURAL = "corpora";
export const CONNECTION_PLURAL = "connections";

/** The slice of the custom-objects API this registry uses. */
export interface CustomObjectsApiLike {
  listNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<{ items?: unknown[] }>;
}

/** The slice of the core API needed to read a Secret. */
export interface CoreApiLike {
  readNamespacedSecret(args: { name: string; namespace: string }): Promise<{
    data?: Record<string, string>;
  }>;
}

export interface CrdCorpusRegistryOptions {
  namespace: string;
  group: string;
  version: string;
  api: CustomObjectsApiLike;
  core: CoreApiLike;
  watchFn?: WatchCrdFn;
  /** Reported rather than thrown: one broken Corpus must not take the others down. */
  onError?: (corpus: string, err: unknown) => void;
}

/**
 * Serves the broker's bindings from `Corpus` custom resources and the
 * `Connection`s they draw from (ADR 0043).
 *
 * Both kinds are watched, because a binding depends on both: a Corpus supplies
 * the scope and the roles, its Connection the driver, the address and the
 * credential. A Connection edit — a rotated Secret reference, a tightened
 * allowlist — has to rebuild every binding over it, or the broker keeps acting
 * on what that Connection used to say.
 *
 * Bindings are built at load rather than per request: constructing one reads a
 * Secret, and doing that on the request path would put a credential fetch in
 * front of every probe.
 *
 * A Corpus that cannot be bound is OMITTED rather than served degraded, and the
 * reason is reported. The request path then answers "unknown corpus", which is
 * truthful — a half-built binding would answer with a driver pointed somewhere
 * unintended, and every scope check downstream would pass because they would
 * all be evaluated against wherever it was pointed.
 */
export class CrdCorpusRegistry implements CorpusRegistry {
  private readonly bindings = new Map<string, CorpusBinding>();
  /**
   * The resources behind the bindings, kept because the sync scheduler needs
   * fields the binding deliberately does not carry — the collection the
   * controller published, and the reconcile interval.
   */
  private readonly corpora = new Map<string, CorpusCustomResource>();
  private readonly connections = new Map<string, ConnectionCustomResource>();
  private readonly watchers: { stop: () => void }[] = [];

  constructor(private readonly options: CrdCorpusRegistryOptions) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
    onError?: (corpus: string, err: unknown) => void,
  ): CrdCorpusRegistry {
    return new CrdCorpusRegistry({
      namespace,
      group,
      version,
      api: kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      core: kubeConfig.makeApiClient(k8s.CoreV1Api),
      watchFn: makeCrdWatcher(kubeConfig),
      onError,
    });
  }

  get(name: string): CorpusBinding | undefined {
    return this.bindings.get(name);
  }

  list(): CorpusBinding[] {
    return [...this.bindings.values()];
  }

  /** The CRs behind those bindings, for fields the binding does not carry. */
  listResources(): CorpusCustomResource[] {
    return [...this.corpora.values()];
  }

  /** Every Corpus drawing from one Connection, for webhook fan-out. */
  corporaFor(connection: string): CorpusBinding[] {
    return this.list().filter((binding) => binding.connection === connection);
  }

  /** One-shot load, for startup. */
  async loadAll(): Promise<void> {
    // Connections FIRST: a Corpus cannot be bound without the one it names, and
    // loading in the other order would report every Corpus as broken on a cold
    // start and then quietly fix itself.
    for (const item of await this.listKind(CONNECTION_PLURAL)) {
      const connection = item as ConnectionCustomResource;
      if (connection?.metadata?.name) this.connections.set(connection.metadata.name, connection);
    }
    for (const item of await this.listKind(CORPUS_PLURAL)) {
      await this.upsertCorpus(item as CorpusCustomResource);
    }
  }

  /** Keeps the bindings current afterwards (ADR 0020). */
  watch(): { stop: () => void } {
    if (!this.options.watchFn) throw new Error("this registry was built without a watch function");

    this.watchers.push(
      this.watchKind(CORPUS_PLURAL, (phase, obj) => {
        const corpus = obj as CorpusCustomResource;
        const name = corpus?.metadata?.name;
        if (!name) return;
        if (phase === "DELETED") {
          this.bindings.delete(name);
          this.corpora.delete(name);
          return;
        }
        void this.upsertCorpus(corpus);
      }),
    );

    this.watchers.push(
      this.watchKind(CONNECTION_PLURAL, (phase, obj) => {
        const connection = obj as ConnectionCustomResource;
        const name = connection?.metadata?.name;
        if (!name) return;
        if (phase === "DELETED") {
          this.connections.delete(name);
        } else {
          this.connections.set(name, connection);
        }
        // Every Corpus over it is now describing a Connection that changed or
        // went away, so all of them are rebuilt. A deleted Connection drops
        // them, which is the correct answer: there is no credential to serve
        // them with.
        void this.rebuildFor(name);
      }),
    );

    return { stop: () => this.stop() };
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.stop();
    this.watchers.length = 0;
  }

  private async listKind(plural: string): Promise<unknown[]> {
    const response = await this.options.api.listNamespacedCustomObject({
      group: this.options.group,
      version: this.options.version,
      namespace: this.options.namespace,
      plural,
    });
    return response.items ?? [];
  }

  private watchKind(
    plural: string,
    onEvent: (phase: "ADDED" | "MODIFIED" | "DELETED", obj: unknown) => void,
  ): { stop: () => void } {
    return this.options.watchFn!(
      {
        group: this.options.group,
        version: this.options.version,
        namespace: this.options.namespace,
        plural,
      },
      onEvent,
      (err) => this.options.onError?.(`(watch ${plural})`, err),
    );
  }

  private async rebuildFor(connection: string): Promise<void> {
    for (const corpus of this.corpora.values()) {
      if (corpus.spec?.connectionRef === connection) await this.upsertCorpus(corpus);
    }
  }

  private async upsertCorpus(corpus: CorpusCustomResource): Promise<void> {
    const name = corpus?.metadata?.name;
    if (!name) return;

    // Recorded before the bind is attempted, so a Corpus whose Connection has
    // not arrived yet is rebuilt when it does rather than forgotten.
    this.corpora.set(name, corpus);

    const connection = this.connections.get(corpus.spec?.connectionRef ?? "");
    if (!connection) {
      this.bindings.delete(name);
      this.options.onError?.(
        name,
        new Error(`connectionRef ${corpus.spec?.connectionRef} does not resolve`),
      );
      return;
    }

    try {
      this.bindings.set(name, await toBinding(corpus, connection, this.secretReader(corpus)));
    } catch (err) {
      // Drop rather than keep a previous binding: if the CR was edited into an
      // invalid state, continuing to serve the old one would keep using a
      // credential or scope the operator has just revoked.
      this.bindings.delete(name);
      this.options.onError?.(name, err);
    }
  }

  /**
   * Reads Secrets from the Corpus's OWN namespace, never a caller-supplied one.
   * A Corpus reaching across namespaces for a credential would make the broker
   * a tool for reading any Secret in the cluster.
   */
  private secretReader(corpus: CorpusCustomResource): SecretReader {
    const namespace = corpus.metadata.namespace ?? this.options.namespace;
    return async (secretName, key) => {
      const secret = await this.options.core.readNamespacedSecret({ name: secretName, namespace });
      const encoded = secret.data?.[key];
      // k8s Secret values are base64 over the wire.
      return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
    };
  }
}
