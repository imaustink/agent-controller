import { describe, expect, it, vi } from "vitest";
import { MCPBrokerClient } from "./mcp-broker-client.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool = {
  id: "mcp:github/create_issue",
  name: "mcp:github/create_issue",
  description: "Opens a GitHub issue",
  allowedRoles: ["writer"],
  identityProviders: ["github"],
  mcpExec: { serverRef: "github", remoteToolName: "create_issue", inputSchema: '{"type":"object"}' },
} as unknown as ToolDescriptor;

// A server that needs no per-user credential (no identityProviders).
const publicTool = {
  id: "mcp:weather/forecast",
  name: "mcp:weather/forecast",
  description: "Public weather",
  allowedRoles: ["reader"],
  mcpExec: { serverRef: "weather", remoteToolName: "forecast" },
} as unknown as ToolDescriptor;

const CALLER = { subject: "openwebui:42" };

// No default for the credential: `client(http, undefined)` must mean "nothing
// linked", and a default would silently turn that into the happy path.
function client(fetchImpl: typeof fetch, ...credential: [{ token: string } | undefined] | []) {
  const resolved = credential.length === 0 ? { token: "user-token" } : credential[0];
  return new MCPBrokerClient({
    brokerUrl: "http://mcp-broker.test/",
    brokerToken: "orchestrator-secret",
    credentials: {
      delegatedToken: vi.fn().mockResolvedValue(resolved),
      delegatedTokens: vi.fn().mockResolvedValue(new Map()),
    },
    fetchImpl,
  });
}

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe("call", () => {
  it("proxies one tools/call as the caller, forwarding raw JSON arguments and the delegated token", async () => {
    const http = vi.fn().mockResolvedValue(ok({ result: "Issue #7 created", isError: false }));

    const result = await client(http as unknown as typeof fetch).call(
      tool,
      '{"title":"Bug"}',
      CALLER,
    );

    expect(http.mock.calls[0]![0]).toBe(
      "http://mcp-broker.test/servers/github/tools/create_issue/call",
    );
    const init = http.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer orchestrator-secret",
      "x-delegated-token": "user-token",
    });
    // Arguments forwarded as raw JSON for the broker to validate against the schema.
    expect(JSON.parse(init.body as string)).toEqual({ arguments: { title: "Bug" } });
    expect(result.result).toBe("Issue #7 created");
    expect(result.needsLink).toBeUndefined();
  });

  it("defaults empty arguments to {}", async () => {
    const http = vi.fn().mockResolvedValue(ok({ result: "ok", isError: false }));
    await client(http as unknown as typeof fetch).call(publicTool, "  ", CALLER);
    expect(JSON.parse((http.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ arguments: {} });
  });

  it("never sends a delegated token for a server that declares no identityProviders", async () => {
    const http = vi.fn().mockResolvedValue(ok({ result: "sunny", isError: false }));
    await client(http as unknown as typeof fetch).call(publicTool, "{}", CALLER);
    // The broker's discovery identity is never spent on an invocation.
    expect((http.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("x-delegated-token");
  });

  it("FAILS CLOSED: asks for a link rather than calling the broker with a fallback credential", async () => {
    // A per-user call quietly becoming a shared-identity call is exactly the
    // failure mode ADR 0045 §5 forbids.
    const http = vi.fn();
    const result = await client(http as unknown as typeof fetch, undefined).call(tool, "{}", CALLER);

    expect(result.needsLink).toBe(true);
    expect(result.result).toContain("link the account behind github");
    expect(http).not.toHaveBeenCalled();
  });

  it("returns a tool-level error (isError) as PROSE the model can act on, not a throw", async () => {
    const http = vi.fn().mockResolvedValue(ok({ result: "title is required", isError: true }));
    const result = await client(http as unknown as typeof fetch).call(tool, "{}", CALLER);
    expect(result.result).toBe("title is required");
    expect(result.needsLink).toBeUndefined();
  });

  it("returns a broker refusal (non-2xx) as prose carrying the broker's message", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "delegated token expired" }),
    } as Response);

    const result = await client(http as unknown as typeof fetch).call(tool, "{}", CALLER);

    expect(result.result).toContain("refused that call (403)");
    expect(result.result).toContain("delegated token expired");
  });

  it("returns invalid JSON arguments as prose rather than a throw", async () => {
    const http = vi.fn();
    const result = await client(http as unknown as typeof fetch).call(tool, "not json", CALLER);
    expect(result.result).toContain("not valid JSON");
    expect(http).not.toHaveBeenCalled();
  });

  it("raises when the broker cannot be reached at all", async () => {
    // Distinct from a refusal: we did not get an answer, and reporting one would
    // be inventing it.
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client(http as unknown as typeof fetch).call(tool, "{}", CALLER)).rejects.toThrow(
      /unreachable/,
    );
  });

  it("refuses a tool that is not an MCP tool", async () => {
    const bare = { ...tool, mcpExec: undefined } as unknown as ToolDescriptor;
    await expect(client(vi.fn() as unknown as typeof fetch).call(bare, "{}", CALLER)).rejects.toThrow(
      /not an MCP tool/,
    );
  });
});
