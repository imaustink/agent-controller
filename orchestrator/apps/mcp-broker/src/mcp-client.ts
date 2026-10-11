import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The broker's thin wrapper over the MCP client SDK — the ONE place that speaks
 * the protocol (ADR 0045 §3). Everything above this file deals in plain tool
 * inventories and tool-call results; the session handshake, the transport and
 * the SDK framing stay quarantined here.
 *
 * Two operations, each opening a FRESH, sessionless client and closing it
 * (ADR 0045 §5): `listTools` for discovery (under the shared service
 * credential) and `callTool` for invocation (under the caller's per-user
 * token). The broker holds no per-user session — a shared session fanned across
 * callers is exactly the shared-subject identity collapse this design refuses.
 */

/** One tool as the server advertises it in tools/list. */
export interface DiscoveredTool {
  name: string;
  description?: string;
  /** The raw JSON Schema object the server returned, or undefined. */
  inputSchema?: unknown;
}

/** A tools/call result, flattened in flattenToolResult below. */
export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpClient {
  listTools(opts: { url: string; token?: string }): Promise<DiscoveredTool[]>;
  callTool(opts: {
    url: string;
    token?: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolCallResult>;
}

/**
 * A transport/protocol failure talking to a server — unreachable, a bad
 * handshake, a malformed frame.
 *
 * Named distinctly so the HTTP surface can map it to 502 (the server is at
 * fault) and keep it separate from an authorization decision the broker itself
 * made. One bad server must never look like a broker bug.
 */
export class McpTransportError extends Error {
  readonly name = "McpTransportError";
}

/** The real SDK-backed client. Tests inject a fake McpClient instead. */
export class SdkMcpClient implements McpClient {
  async listTools(opts: { url: string; token?: string }): Promise<DiscoveredTool[]> {
    return this.withClient(opts, async (client) => {
      const result = await client.listTools();
      const tools = (result.tools ?? []) as Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    });
  }

  async callTool(opts: {
    url: string;
    token?: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolCallResult> {
    return this.withClient(opts, async (client) => {
      const result = (await client.callTool({
        name: opts.name,
        arguments: opts.arguments,
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      return { content: result.content ?? [], isError: Boolean(result.isError) };
    });
  }

  /**
   * Opens a fresh client, runs one operation, and always closes it.
   *
   * Any failure to connect or converse becomes an McpTransportError, so callers
   * never see raw SDK or fetch errors and can map the whole class to one HTTP
   * status. The header is omitted entirely when no token is given — a server
   * that needs no credential to list its tools gets an unauthenticated request,
   * not an empty bearer.
   */
  private async withClient<T>(
    opts: { url: string; token?: string },
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers },
    });
    const client = new Client({ name: "mcp-broker", version: "0.1.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      return await run(client);
    } catch (err) {
      throw new McpTransportError(
        `MCP request to ${opts.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Best-effort: the call already succeeded or failed; a close error must
      // not mask that outcome.
      await client.close().catch(() => {});
    }
  }
}

/**
 * Flattens an MCP CallToolResult's content to a single text string.
 *
 * Text parts are concatenated in order; a non-text part (image, resource, …)
 * is noted by its type in brackets rather than dropped silently, so a caller
 * sees that content existed it cannot render as text. `isError` passes through,
 * defaulting false.
 */
export function flattenToolResult(result: ToolCallResult): { result: string; isError: boolean } {
  const text = (result.content ?? [])
    .map((part) =>
      part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
    )
    .join("");
  return { result: text, isError: Boolean(result.isError) };
}
