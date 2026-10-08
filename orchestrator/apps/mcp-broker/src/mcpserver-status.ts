import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";

import {
  MCPSERVER_PLURAL,
  type K8sCondition,
  type MCPDiscoveredTool,
  type MCPServerCustomResource,
} from "./mcp-server-resource.js";

/** The slice of the custom-objects API needed to patch a status subresource. */
export interface StatusPatcherApi {
  patchNamespacedCustomObjectStatus(
    args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
      body: unknown;
    },
    options?: unknown,
  ): Promise<unknown>;
}

/**
 * A merge patch, said explicitly.
 *
 * The client defaults this endpoint to `application/json-patch+json`, which
 * expects an ARRAY of operations; sending `{ status: {...} }` under that type is
 * rejected by the API server. connection-broker's CorpusStatusWriter hit
 * exactly this and its comment is worth keeping: the second arg to the patch
 * call is `ConfigurationOptions`, so a bare `{ headers }` type-checks and is
 * silently ignored — it has to go through `setHeaderOptions`.
 */
const MERGE_PATCH = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

export interface MCPServerStatusWriterOptions {
  api: StatusPatcherApi;
  namespace: string;
  group: string;
  version: string;
  now?: () => Date;
  onError?: (server: string, err: unknown) => void;
}

/**
 * Publishes discovery results back onto an MCPServer's status (ADR 0045 §4).
 *
 * `discoveredTools` is the full inventory the server advertised — a REPORT, not
 * a grant — each marked `exposed` per the operator's map. A successful pass sets
 * a Ready condition; a server the broker could not reach or list gets a Degraded
 * condition with the reason, and NO change to discoveredTools, so the last known
 * inventory is not thrown away because the server blipped.
 *
 * A failure to write status is REPORTED, never fatal: the discovery already
 * happened and the MCPTools are already materialized; failing the pass because
 * the bookkeeping did not land would throw away real work to protect a status
 * blob (same discipline as connection-broker).
 */
export class MCPServerStatusWriter {
  constructor(private readonly options: MCPServerStatusWriterOptions) {}

  /** Records a successful discovery. */
  async recordReady(
    server: MCPServerCustomResource,
    discoveredTools: MCPDiscoveredTool[],
    exposedTools: number,
  ): Promise<void> {
    await this.patch(server, {
      discoveredTools,
      exposedTools,
      observedGeneration: server.metadata.generation,
      conditions: [
        this.condition(server, "Ready", "True", "DiscoverySucceeded", "Listed tools from the server"),
      ],
    });
  }

  /** Records a server the broker could not reach or list. */
  async recordDegraded(server: MCPServerCustomResource, message: string): Promise<void> {
    await this.patch(server, {
      observedGeneration: server.metadata.generation,
      conditions: [this.condition(server, "Ready", "False", "DiscoveryFailed", message)],
    });
  }

  private condition(
    server: MCPServerCustomResource,
    type: string,
    status: K8sCondition["status"],
    reason: string,
    message: string,
  ): K8sCondition {
    return {
      type,
      status,
      reason,
      message,
      lastTransitionTime: (this.options.now?.() ?? new Date()).toISOString(),
      observedGeneration: server.metadata.generation,
    };
  }

  private async patch(server: MCPServerCustomResource, status: Record<string, unknown>): Promise<void> {
    try {
      await this.options.api.patchNamespacedCustomObjectStatus(
        {
          group: this.options.group,
          version: this.options.version,
          namespace: this.options.namespace,
          plural: MCPSERVER_PLURAL,
          name: server.metadata.name,
          body: { status },
        },
        MERGE_PATCH,
      );
    } catch (err) {
      this.options.onError?.(server.metadata.name, err);
    }
  }
}
