import type { ToolDescriptor } from "../tool-descriptor.js";
import type { DelegatedCredentialResolver } from "../knowledge-base/searcher.js";

export interface MCPBrokerClientOptions {
  /** Base URL of the mcp-broker Service. */
  brokerUrl: string;
  /** Authenticates THIS orchestrator to the broker (distinct from the per-user delegated token it carries onward). */
  brokerToken: string;
  /** Resolves the caller's OWN delegated token for the server's identityProviders (the ADR 0032/0040 path). */
  credentials: DelegatedCredentialResolver;
  fetchImpl?: typeof fetch;
}

export interface MCPCallResult {
  /** Prose for the model — a tool result, a tool-level error, or a link prompt. */
  result: string;
  /** Set when the server requires a per-user identity the caller has not linked. */
  needsLink?: boolean;
}

/** The mcp-broker's normalized `tools/call` reply: the MCP content flattened to text, plus whether the server flagged an error. */
interface BrokerCallResponse {
  result?: string;
  isError?: boolean;
  /** A transport/validation failure the broker itself produced (as opposed to a tool-level error the server returned). */
  message?: string;
}

/**
 * Proxies one MCP `tools/call` through the mcp-broker, as the calling user
 * (ADR 0045). The engine never speaks MCP; the broker holds the session, and
 * this only resolves the caller's credential and relays one request — the same
 * containment ADR 0014's LocalTool and ADR 0038's Corpus GET face give their
 * runtimes.
 *
 * It is shaped like {@link CorpusReader}: the per-user delegated token is
 * resolved HERE, never returned to the graph, and every "the call did not
 * succeed" outcome comes back as PROSE the model can act on (fix the arguments,
 * try another tool, ask the user to link) rather than a thrown turn. A throw is
 * reserved for the broker being unreachable, which should surface rather than
 * look like a tool that ran and refused.
 *
 * FAIL CLOSED (ADR 0045 §5): when the server declares identityProviders and the
 * caller has not linked, this asks for a link and never falls back to the
 * broker's shared discovery credential — a per-user call quietly becoming a
 * shared-identity call is exactly the failure mode to forbid.
 *
 * PARITY: `MCPActivities.RunMCPTool` in
 * `orchestrator/engines/temporal/internal/temporal/activities/mcptool.go`.
 */
export class MCPBrokerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MCPBrokerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(tool: ToolDescriptor, args: string, caller: { subject: string }): Promise<MCPCallResult> {
    const exec = tool.mcpExec;
    if (!exec) {
      throw new Error(`tool ${tool.id} is not an MCP tool`);
    }

    // Resolve the per-user credential only when the server declares it needs
    // one. A server with no identityProviders is called with no delegated token
    // (the broker's discovery identity is never spent on an invocation).
    let delegated: string | undefined;
    if (tool.identityProviders && tool.identityProviders.length > 0) {
      const credential = await this.options.credentials.delegatedToken(caller.subject, tool.identityProviders);
      if (!credential?.token) {
        // Asked rather than failed, and never silently fallen back to the
        // broker's shared discovery credential — that would answer a different
        // question, permissively.
        return {
          needsLink: true,
          result:
            `I need you to link the account behind ${exec.serverRef} before I can call it — ` +
            "an MCP tool call has to run as you, not as a shared credential.",
        };
      }
      delegated = credential.token;
    }

    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` +
      `/servers/${encodeURIComponent(exec.serverRef)}/tools/${encodeURIComponent(exec.remoteToolName)}/call`;

    // Forward the planner's arguments as raw JSON so the broker — the only MCP
    // speaker — owns parsing and validation against the remote tool's schema.
    // Non-JSON is a tool-level problem the model can correct, so it is prose,
    // not a thrown turn.
    const raw = (args ?? "").trim() || "{}";
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(raw);
    } catch (err) {
      return {
        result: `The arguments were not valid JSON for ${exec.serverRef}/${exec.remoteToolName}: ${errMsg(err)}`,
      };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.brokerToken}`,
    };
    // Present the delegated token ONLY when one was resolved (i.e. the server
    // declared identityProviders) — never the broker's own credential.
    if (delegated) headers["x-delegated-token"] = delegated;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ arguments: parsedArgs }),
      });
    } catch (cause) {
      throw new Error(`mcp-broker unreachable: ${String(cause)}`);
    }

    let parsed: BrokerCallResponse = {};
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text) as BrokerCallResponse;
      } catch {
        // A broker that is up but talking gibberish is misbehaving, not a tool
        // that refused — surface it rather than inventing a result.
        throw new Error(`mcp-broker returned non-JSON body: ${text.slice(0, 200)}`);
      }
    }

    if (!response.ok) {
      // A refusal from the broker (unknown tool, expired/forbidden delegated
      // token, server unreachable) is returned as prose the model can act on,
      // mirroring the knowledge-base GET face: a thrown error just ends the turn
      // where a message lets the model recover or explain.
      const detail = (parsed.message ?? text).trim();
      return { result: `The MCP server refused that call (${response.status}). ${detail}`.trim() };
    }

    // A tool-level error (`isError: true`) is still an ANSWER the model can act
    // on, so — like a success — it comes back as the broker's flattened text,
    // never a throw.
    return { result: parsed.result ?? "" };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
