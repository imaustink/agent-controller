import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type WatchCrdFn } from "./k8s/crd-watcher.js";
import {
  toBinding,
  type ConnectionCustomResource,
  type SecretReader,
} from "./connection-resource.js";
import type { ConnectionBinding, ConnectionRegistry } from "./registry.js";

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

export interface CrdConnectionRegistryOptions {
  namespace: string;
  group: string;
  version: string;
  api: CustomObjectsApiLike;
  core: CoreApiLike;
  watchFn?: WatchCrdFn;
  /** Reported rather than thrown: one broken Connection must not take the others down. */
  onError?: (connection: string, err: unknown) => void;
}

/**
 * Serves the broker's bindings from `Connection` custom resources.
 *
 * Bindings are built once, at load, rather than per request: constructing a
 * driver reads a Secret, and doing that on the request path would put a
 * credential fetch in front of every probe.
 *
 * A Connection that cannot be bound is OMITTED rather than served degraded, and
 * the reason is reported. The request path then answers "unknown connection",
 * which is the truthful response — a half-built binding would answer with a
 * driver pointed somewhere unintended, and every scope check downstream would
 * pass because they would all be evaluated against wherever it was pointed.
 */
export class CrdConnectionRegistry implements ConnectionRegistry {
  private readonly bindings = new Map<string, ConnectionBinding>();
  /**
   * The resources behind the bindings, kept because the sync scheduler needs
   * fields the binding deliberately does not carry — the collection the
   * controller published, and the reconcile interval.
   */
  private readonly resources = new Map<string, ConnectionCustomResource>();
  private watcher: { stop: () => void } | undefined;

  constructor(private readonly options: CrdConnectionRegistryOptions) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
    onError?: (connection: string, err: unknown) => void,
  ): CrdConnectionRegistry {
    return new CrdConnectionRegistry({
      namespace,
      group,
      version,
      api: kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      core: kubeConfig.makeApiClient(k8s.CoreV1Api),
      watchFn: makeCrdWatcher(kubeConfig),
      onError,
    });
  }

  get(name: string): ConnectionBinding | undefined {
    return this.bindings.get(name);
  }

  /** Every connection currently bound, for the sync scheduler to walk. */
  list(): ConnectionBinding[] {
    return [...this.bindings.values()];
  }

  /** The CRs behind those bindings, for fields the binding does not carry. */
  listResources(): ConnectionCustomResource[] {
    return [...this.resources.values()];
  }

  /** One-shot load, for startup. */
  async loadAll(): Promise<void> {
    const response = await this.options.api.listNamespacedCustomObject({
      group: this.options.group,
      version: this.options.version,
      namespace: this.options.namespace,
      plural: CONNECTION_PLURAL,
    });
    for (const item of response.items ?? []) {
      await this.upsert(item as ConnectionCustomResource);
    }
  }

  /** Keeps the bindings current afterwards (ADR 0020). */
  watch(): { stop: () => void } {
    if (!this.options.watchFn) throw new Error("this registry was built without a watch function");

    this.watcher = this.options.watchFn(
      {
        group: this.options.group,
        version: this.options.version,
        namespace: this.options.namespace,
        plural: CONNECTION_PLURAL,
      },
      (phase, obj) => {
        const cr = obj as ConnectionCustomResource;
        const name = cr?.metadata?.name;
        if (!name) return;
        if (phase === "DELETED") {
          // The credential stops being usable the moment the CR is gone.
          this.bindings.delete(name);
          this.resources.delete(name);
          return;
        }
        void this.upsert(cr);
      },
      (err) => this.options.onError?.("(watch)", err),
    );
    return this.watcher;
  }

  stop(): void {
    this.watcher?.stop();
  }

  private async upsert(cr: ConnectionCustomResource): Promise<void> {
    const name = cr?.metadata?.name;
    if (!name) return;
    try {
      this.bindings.set(name, await toBinding(cr, this.secretReader(cr)));
      this.resources.set(name, cr);
    } catch (err) {
      // Drop rather than keep a previous binding: if the CR was edited into an
      // invalid state, continuing to serve the old one would keep using a
      // credential or scope the operator has just revoked.
      this.bindings.delete(name);
      this.resources.delete(name);
      this.options.onError?.(name, err);
    }
  }

  /**
   * Reads Secrets from the Connection's OWN namespace, never a caller-supplied
   * one. A Connection reaching across namespaces for a credential would make
   * the broker a tool for reading any Secret in the cluster.
   */
  private secretReader(cr: ConnectionCustomResource): SecretReader {
    const namespace = cr.metadata.namespace ?? this.options.namespace;
    return async (secretName, key) => {
      const secret = await this.options.core.readNamespacedSecret({ name: secretName, namespace });
      const encoded = secret.data?.[key];
      // k8s Secret values are base64 over the wire.
      return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
    };
  }
}
