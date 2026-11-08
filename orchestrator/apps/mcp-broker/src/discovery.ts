import {
  catalogIdFor,
  exposureByRemoteName,
  isExposed,
  type MCPDiscoveredTool,
  type MCPServerCustomResource,
} from "./mcp-server-resource.js";
import type { McpClient } from "./mcp-client.js";
import { McpTransportError } from "./mcp-client.js";
import type { MCPServerBinding } from "./mcpserver-registry.js";
import type { MCPServerStatusWriter } from "./mcpserver-status.js";
import type { DesiredTool, MCPToolWriter } from "./mcptool-writer.js";

/**
 * Discovery: the controller half of the broker (ADR 0045 §3, §4, §6).
 *
 * For each MCPServer — on load, on change, and on a periodic resync — it opens
 * an MCP client under the server's DISCOVERY credential, lists the server's
 * tools, and does two things with the result:
 *
 *   1. Writes the full inventory to `status.discoveredTools`, each tool marked
 *      `exposed` per the operator's map. This grants nothing; it only surfaces
 *      what the server offers so an operator can decide what to expose.
 *   2. Materializes an MCPTool for every exposure entry (expose !== false) whose
 *      remote tool is actually in the live list, and DELETES any owned MCPTool
 *      whose remote tool left the list or whose exposure was withdrawn.
 *
 * The division of authority is the point (§6): the LIVE SERVER decides what
 * exists, the OPERATOR decides what is permitted. So a tool materializes only
 * when both agree — the server still advertises it AND an exposure entry names
 * it — and a reappearing tool re-enters discoveredTools but is re-materialized
 * only if the exposure map still covers it.
 *
 * One bad server must never stop the others: every per-server failure is caught,
 * recorded as Degraded, and left behind. Crucially, a server the broker could
 * not reach does NOT have its tools deleted — unreachable is "we do not know",
 * not "nothing exists", and deleting on a blip would flap the whole catalog.
 */
export interface DiscoveryOptions {
  client: McpClient;
  toolWriter: MCPToolWriter;
  statusWriter: MCPServerStatusWriter;
  onError?: (server: string, err: unknown) => void;
}

export class Discovery {
  constructor(private readonly options: DiscoveryOptions) {}

  /** Runs discovery for every bound server, never throwing for any one of them. */
  async runAll(bindings: MCPServerBinding[]): Promise<void> {
    for (const binding of bindings) {
      await this.runServer(binding);
    }
  }

  async runServer(binding: MCPServerBinding): Promise<void> {
    const server = binding.cr;
    const name = server.metadata.name;

    let tools;
    try {
      tools = await this.options.client.listTools({
        url: server.spec.url,
        token: binding.serviceToken,
      });
    } catch (err) {
      // Unreachable or protocol error: record Degraded and STOP. The existing
      // MCPTools are deliberately left in place — the live server is truth for
      // existence, and right now we cannot see the live server.
      const message =
        err instanceof McpTransportError ? err.message : `discovery failed: ${String(err)}`;
      await this.options.statusWriter.recordDegraded(server, message);
      this.options.onError?.(name, err);
      return;
    }

    const exposure = exposureByRemoteName(server);

    // The inventory, in the order the server reported it, each marked exposed
    // only when an entry names it AND that entry is not withdrawn.
    const discoveredTools: MCPDiscoveredTool[] = tools.map((tool) => {
      const entry = exposure.get(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: serializeSchema(tool.inputSchema),
        exposed: entry ? isExposed(entry) : false,
      };
    });

    // What should exist: an exposure entry that is exposed AND whose remote tool
    // the server actually advertised right now. An entry naming a tool the
    // server does not list materializes nothing (and is not in discoveredTools).
    const liveNames = new Set(tools.map((tool) => tool.name));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const desired: DesiredTool[] = [];
    for (const [remoteToolName, entry] of exposure) {
      if (!isExposed(entry)) continue;
      if (!liveNames.has(remoteToolName)) continue;
      const live = byName.get(remoteToolName)!;
      desired.push({
        catalogId: catalogIdFor(name, entry),
        spec: {
          serverRef: name,
          remoteToolName,
          // description/inputSchema come from the LIVE tool (what it is);
          // allowedRoles/hidden/tier from the EXPOSURE entry (what the operator
          // permits); identityProviders from the SERVER (how to run as the user).
          description: live.description ?? remoteToolName,
          ...(serializeSchema(live.inputSchema) !== undefined
            ? { inputSchema: serializeSchema(live.inputSchema) }
            : {}),
          allowedRoles: entry.allowedRoles ?? [],
          ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
          ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
          ...(entry.approval !== undefined ? { approval: entry.approval } : {}),
          ...(server.spec.identityProviders && server.spec.identityProviders.length > 0
            ? { identityProviders: server.spec.identityProviders }
            : {}),
        },
      });
    }

    // Materialize/delete first so the catalog is current, then publish status.
    await this.options.toolWriter.reconcile(server, desired);
    await this.options.statusWriter.recordReady(server, discoveredTools, desired.length);
  }
}

/**
 * Serializes a tool's input schema to the JSON string the CRD stores.
 *
 * `undefined` stays `undefined` (the field is optional); anything else is
 * JSON.stringify'd verbatim so an operator sees exactly what the server
 * advertised. A value that cannot be serialized is dropped rather than throwing
 * — a broken schema must not fail the whole server's discovery.
 */
function serializeSchema(schema: unknown): string | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    return JSON.stringify(schema);
  } catch {
    return undefined;
  }
}
