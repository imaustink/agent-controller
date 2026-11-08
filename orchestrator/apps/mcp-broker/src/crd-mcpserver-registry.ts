import * as k8s from "@kubernetes/client-node";

import { makeCrdWatcher, type WatchCrdFn } from "./k8s/crd-watcher.js";
import {
  MCPSERVER_PLURAL,
  type MCPServerCustomResource,
} from "./mcp-server-resource.js";
import type { MCPServerBinding, MCPServerRegistry } from "./mcpserver-registry.js";

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

/** Reads one key from one Secret. Injected so secret resolution stays testable. */
export type SecretReader = (secretName: string, key: string) => Promise<string | undefined>;

export interface CrdMCPServerRegistryOptions {
  namespace: string;
  group: string;
  version: string;
  api: CustomObjectsApiLike;
  core: CoreApiLike;
  watchFn?: WatchCrdFn;
  /** Called after a server's binding changes, so discovery can re-run for it. */
  onChange?: (binding: MCPServerBinding) => void;
  /** Called when a server is deleted, so discovery/catalog can react. */
  onDelete?: (name: string) => void;
  /** Reported rather than thrown: one broken server must not take the others down. */
  onError?: (server: string, err: unknown) => void;
}

/**
 * Serves the broker's bindings from `MCPServer` custom resources (ADR 0045).
 *
 * Each binding carries the CR and the resolved DISCOVERY credential. The token
 * is resolved at load from the server's `secretEnv` — the FIRST entry, used as
 * the bearer for tools/list — so a Secret read never lands on the request path.
 * A server with no `secretEnv` binds with no token, which is legitimate: a
 * server that needs no credential to list its tools, or one that only ever runs
 * as the user via `identityProviders`.
 *
 * Unlike connection-broker's registry, a server that cannot resolve its secret
 * is still BOUND (with no token) rather than omitted: discovery will then record
 * it Degraded when tools/list fails, which is more legible than the server
 * silently not existing — and invocation under `identityProviders` does not need
 * the discovery credential at all.
 */
export class CrdMCPServerRegistry implements MCPServerRegistry {
  private readonly bindings = new Map<string, MCPServerBinding>();
  private readonly watchers: { stop: () => void }[] = [];

  constructor(private readonly options: CrdMCPServerRegistryOptions) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
    hooks: Pick<CrdMCPServerRegistryOptions, "onChange" | "onDelete" | "onError"> = {},
  ): CrdMCPServerRegistry {
    return new CrdMCPServerRegistry({
      namespace,
      group,
      version,
      api: kubeConfig.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomObjectsApiLike,
      core: kubeConfig.makeApiClient(k8s.CoreV1Api) as unknown as CoreApiLike,
      watchFn: makeCrdWatcher(kubeConfig),
      ...hooks,
    });
  }

  get(name: string): MCPServerBinding | undefined {
    return this.bindings.get(name);
  }

  list(): MCPServerBinding[] {
    return [...this.bindings.values()];
  }

  /** One-shot load, for startup. Does NOT fire onChange (the caller runs discovery). */
  async loadAll(): Promise<void> {
    const response = await this.options.api.listNamespacedCustomObject({
      group: this.options.group,
      version: this.options.version,
      namespace: this.options.namespace,
      plural: MCPSERVER_PLURAL,
    });
    for (const item of response.items ?? []) {
      await this.bind(item as MCPServerCustomResource, false);
    }
  }

  /** Keeps the bindings current afterwards, firing onChange per upsert. */
  watch(): { stop: () => void } {
    if (!this.options.watchFn) throw new Error("this registry was built without a watch function");

    this.watchers.push(
      this.options.watchFn(
        {
          group: this.options.group,
          version: this.options.version,
          namespace: this.options.namespace,
          plural: MCPSERVER_PLURAL,
        },
        (phase, obj) => {
          const server = obj as MCPServerCustomResource;
          const name = server?.metadata?.name;
          if (!name) return;
          if (phase === "DELETED") {
            this.bindings.delete(name);
            this.options.onDelete?.(name);
            return;
          }
          void this.bind(server, true);
        },
        (err) => this.options.onError?.("(watch mcpservers)", err),
      ),
    );

    return { stop: () => this.stop() };
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.stop();
    this.watchers.length = 0;
  }

  private async bind(server: MCPServerCustomResource, fireChange: boolean): Promise<void> {
    const name = server?.metadata?.name;
    if (!name) return;

    let serviceToken: string | undefined;
    try {
      serviceToken = await this.resolveServiceToken(server);
    } catch (err) {
      // Bound anyway, with no token (see the class comment): discovery will
      // surface the failure as Degraded rather than the server vanishing.
      this.options.onError?.(name, err);
    }

    const binding: MCPServerBinding = { name, cr: server, serviceToken };
    this.bindings.set(name, binding);
    if (fireChange) this.options.onChange?.(binding);
  }

  /**
   * The DISCOVERY credential: the FIRST `secretEnv` entry's value, resolved from
   * a Secret in the server's OWN namespace (never a caller-supplied one). The
   * first entry wins because the broker needs exactly one bearer for tools/list;
   * a server that needs none leaves `secretEnv` empty and binds with no token.
   */
  private async resolveServiceToken(
    server: MCPServerCustomResource,
  ): Promise<string | undefined> {
    const entry = server.spec.secretEnv?.[0];
    if (!entry) return undefined;
    const value = await this.secretReader(server)(entry.secretRef.name, entry.secretRef.key);
    if (!value) {
      throw new Error(
        `MCPServer ${server.metadata.name}: Secret ${entry.secretRef.name}/${entry.secretRef.key} is missing or empty`,
      );
    }
    return value;
  }

  private secretReader(server: MCPServerCustomResource): SecretReader {
    const namespace = server.metadata.namespace ?? this.options.namespace;
    return async (secretName, key) => {
      const secret = await this.options.core.readNamespacedSecret({ name: secretName, namespace });
      const encoded = secret.data?.[key];
      // k8s Secret values are base64 over the wire.
      return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
    };
  }
}
