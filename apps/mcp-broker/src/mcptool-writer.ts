import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";

import {
  GROUP,
  MCPTOOL_KIND,
  MCPTOOL_PLURAL,
  MCPSERVER_KIND,
  SERVER_LABEL,
  VERSION,
  type MCPServerCustomResource,
  type MCPToolCustomResource,
  type MCPToolSpec,
} from "./mcp-server-resource.js";

/** The slice of the custom-objects API needed to write derived MCPTool CRs. */
export interface CustomObjectsWriterApi {
  listNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<{ items?: unknown[] }>;
  createNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    body: unknown;
  }): Promise<unknown>;
  patchNamespacedCustomObject(
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
  deleteNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
}

const MERGE_PATCH = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

/** One MCPTool discovery wants to exist: its catalog id and the spec to stamp. */
export interface DesiredTool {
  catalogId: string;
  spec: MCPToolSpec;
}

export interface MCPToolWriterOptions {
  api: CustomObjectsWriterApi;
  namespace: string;
  group: string;
  version: string;
  /** Reported, never thrown: one tool's write must not stop the others (ADR 0045). */
  onError?: (tool: string, err: unknown) => void;
}

/**
 * Creates, updates and deletes the derived MCPTool CRs an MCPServer owns
 * (ADR 0045 §1, §6).
 *
 * `reconcile` is the whole contract: given the set of tools discovery wants for
 * one server, it makes the cluster match — creating the missing, updating the
 * changed, and DELETING any MCPTool this server owns that is no longer desired.
 * That delete is the existence rule (§6): a remote tool the server renamed,
 * removed, or that the operator stopped exposing must leave the catalog rather
 * than linger as a tombstone that fails only when invoked.
 *
 * Every derived tool carries an ownerReference to its MCPServer (so deleting the
 * server cascades its tools) and a `SERVER_LABEL` naming that server (so its
 * tools can be listed without scanning ownerReferences).
 */
export class MCPToolWriter {
  constructor(private readonly options: MCPToolWriterOptions) {}

  async reconcile(server: MCPServerCustomResource, desired: DesiredTool[]): Promise<void> {
    const owned = await this.listOwned(server.metadata.name);
    const ownedByName = new Map(owned.map((tool) => [tool.metadata.name, tool]));
    const desiredByName = new Map(desired.map((tool) => [tool.catalogId, tool]));

    // Deletes first (the existence rule): a tool no longer desired is removed
    // whether the server dropped it or the operator un-exposed it.
    for (const tool of owned) {
      if (!desiredByName.has(tool.metadata.name)) {
        await this.delete(tool.metadata.name);
      }
    }

    // Then upserts. A name already present is patched (the live tool's schema or
    // the operator's roles may have changed); a new one is created.
    for (const want of desired) {
      const body = this.toolObject(server, want);
      if (ownedByName.has(want.catalogId)) {
        await this.patch(want.catalogId, body);
      } else {
        await this.create(want.catalogId, body);
      }
    }
  }

  /** Every MCPTool in the namespace this server owns, by its label. */
  private async listOwned(server: string): Promise<MCPToolCustomResource[]> {
    const response = await this.options.api.listNamespacedCustomObject({
      group: this.options.group,
      version: this.options.version,
      namespace: this.options.namespace,
      plural: MCPTOOL_PLURAL,
    });
    return (response.items ?? [])
      .map((item) => item as MCPToolCustomResource)
      .filter((tool) => tool?.metadata?.labels?.[SERVER_LABEL] === server);
  }

  private toolObject(server: MCPServerCustomResource, want: DesiredTool): MCPToolCustomResource {
    return {
      apiVersion: `${this.options.group}/${this.options.version}`,
      kind: MCPTOOL_KIND,
      metadata: {
        name: want.catalogId,
        namespace: this.options.namespace,
        labels: { [SERVER_LABEL]: server.metadata.name },
        ownerReferences: [
          {
            apiVersion: server.apiVersion ?? `${GROUP}/${VERSION}`,
            kind: MCPSERVER_KIND,
            name: server.metadata.name,
            uid: server.metadata.uid ?? "",
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      spec: want.spec,
    };
  }

  private async create(name: string, body: MCPToolCustomResource): Promise<void> {
    try {
      await this.options.api.createNamespacedCustomObject({
        group: this.options.group,
        version: this.options.version,
        namespace: this.options.namespace,
        plural: MCPTOOL_PLURAL,
        body,
      });
    } catch (err) {
      this.options.onError?.(name, err);
    }
  }

  private async patch(name: string, body: MCPToolCustomResource): Promise<void> {
    // A merge patch of metadata+spec: labels and ownerReferences are restamped
    // (so a hand-edit that stripped them is corrected) and the spec is brought
    // to the desired state. Status is a subresource and is left untouched.
    try {
      await this.options.api.patchNamespacedCustomObject(
        {
          group: this.options.group,
          version: this.options.version,
          namespace: this.options.namespace,
          plural: MCPTOOL_PLURAL,
          name,
          body: { metadata: body.metadata, spec: body.spec },
        },
        MERGE_PATCH,
      );
    } catch (err) {
      this.options.onError?.(name, err);
    }
  }

  private async delete(name: string): Promise<void> {
    try {
      await this.options.api.deleteNamespacedCustomObject({
        group: this.options.group,
        version: this.options.version,
        namespace: this.options.namespace,
        plural: MCPTOOL_PLURAL,
        name,
      });
    } catch (err) {
      this.options.onError?.(name, err);
    }
  }
}
