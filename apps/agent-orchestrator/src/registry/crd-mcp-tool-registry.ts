import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { MCPExecSpec, ToolDescriptor } from "../tool-descriptor.js";
import type { CustomObjectsApiLike } from "./crd-tool-registry.js";
import type { ToolRegistry } from "./types.js";

/**
 * Shape of an `MCPTool` custom resource (`<group>/<version>`, kind `MCPTool`) —
 * mirrors `controllers/core-controller/api/v1alpha1/mcptool_types.go`'s
 * `MCPToolSpec` (ADR 0045). These objects are DERIVED: the mcp-broker writes
 * them from an `MCPServer`'s exposure map and owns them via an ownerReference,
 * so the orchestrator only ever READS them, same as any other tool CR.
 */
export interface MCPToolCustomResource {
  metadata: { name: string };
  spec: {
    serverRef: string;
    remoteToolName: string;
    description: string;
    inputSchema?: string;
    allowedRoles: string[];
    hidden?: boolean;
    tier?: string;
    /** Tool-approval policy (ADR 0003): "never" | "always" | "auto". Sourced from the MCPServer exposure entry by the broker, exactly like `tier`. */
    approval?: string;
    identityProviders?: string[];
  };
}

/** Plural resource name used by the `MCPTool` CRD (matches config/crd/bases). */
export const MCP_TOOL_PLURAL = "mcptools";

/**
 * Discovers proxied MCP tools from `MCPTool` custom resources (ADR 0045).
 * Unlike {@link CrdToolRegistry} (k8s Jobs) and {@link CrdLocalToolRegistry}
 * (in-pod sidecars), an MCPTool is dispatched by relaying one `tools/call`
 * through the mcp-broker — so each descriptor carries an `mcpExec` spec instead
 * of a `jobTemplate`/`localExec`. The resulting descriptors are unioned with the
 * Tool catalog and indexed into the same RAG store, so skills reference any kind
 * transparently by CR name and the fail-closed retrieval filter applies for free.
 *
 * `listAll()` is a one-shot read used only for the initial catalog at startup;
 * `watch()` (ADR 0020) keeps it current afterward via a live k8s watch, same
 * shape as {@link CrdLocalToolRegistry}. Gated behind `AGENT_MCP_ENABLED` by its
 * caller: a materialized MCPTool carries no image and no localExec, only an
 * `mcpExec` that dispatches through the broker, so indexing one before the broker
 * is deployed lets the planner select a tool it cannot run.
 */
export class CrdMCPToolRegistry implements ToolRegistry {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly api: CustomObjectsApiLike,
    /** Absent in tests that only exercise `listAll()`; real instances always pass one via `fromKubeConfig`. */
    private readonly watchFn?: WatchCrdFn,
  ) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdMCPToolRegistry {
    return new CrdMCPToolRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }

  async listAll(): Promise<ToolDescriptor[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: MCP_TOOL_PLURAL,
    });
    const tools: ToolDescriptor[] = [];
    for (const item of response.items ?? []) {
      const descriptor = toMCPToolDescriptor(item as MCPToolCustomResource);
      if (descriptor) tools.push(descriptor);
    }
    return tools;
  }

  watch(
    onChange: (event: CrdChangeEvent<ToolDescriptor>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void } {
    if (!this.watchFn) {
      throw new Error("CrdMCPToolRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    }
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: MCP_TOOL_PLURAL },
      (phase, obj) => {
        const cr = obj as MCPToolCustomResource;
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          onChange({ type: "delete", id });
          return;
        }
        const descriptor = toMCPToolDescriptor(cr);
        if (descriptor) onChange({ type: "upsert", descriptor });
      },
      onError,
    );
  }
}

export function toMCPToolDescriptor(cr: MCPToolCustomResource): ToolDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  // serverRef + remoteToolName are what the dispatch call is built from; a CR
  // missing either cannot be proxied, so skip it rather than index a tool that
  // fails only when invoked.
  if (!name || !spec?.serverRef || !spec?.remoteToolName) return undefined;

  const mcpExec: MCPExecSpec = {
    serverRef: spec.serverRef,
    remoteToolName: spec.remoteToolName,
    inputSchema: spec.inputSchema,
  };

  return {
    id: name,
    name,
    // Same "description + Input/Output" composition every other tool embeds
    // (ADR 0003/0004): the server's own description plus its input schema, so an
    // MCP tool competes in retrieval and delegate selection with no special case.
    description: spec.inputSchema
      ? `${spec.description}\n\nInput: ${spec.inputSchema}`
      : spec.description,
    allowedRoles: spec.allowedRoles ?? [],
    hidden: spec.hidden ?? false,
    tier: spec.tier,
    approval: spec.approval,
    identityProviders: spec.identityProviders,
    mcpExec,
  };
}
