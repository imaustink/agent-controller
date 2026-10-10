import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createMcpBrokerServer, DELEGATED_TOKEN_HEADER } from "./server.js";
import { McpTransportError, type McpClient, type ToolCallResult } from "./mcp-client.js";
import { StaticMCPServerRegistry, type MCPServerBinding } from "./mcpserver-registry.js";
import type { MCPServerCustomResource } from "./mcp-server-resource.js";

function serverCR(overrides: {
  identityProviders?: string[];
  expose?: boolean;
}): MCPServerCustomResource {
  return {
    metadata: { name: "github-mcp", uid: "u" },
    spec: {
      transport: "streamable-http",
      url: "https://mcp.example/",
      identityProviders: overrides.identityProviders,
      exposure: [
        { remoteToolName: "search_issues", allowedRoles: ["eng"], expose: overrides.expose ?? true },
      ],
    },
  };
}

function fakeClient(result: ToolCallResult | McpTransportError): McpClient {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(async () => {
      if (result instanceof McpTransportError) throw result;
      return result;
    }),
  };
}

describe("mcp-broker invocation server", () => {
  let server: Server;
  let base: string;
  let client: McpClient;

  const start = (
    cr: MCPServerCustomResource,
    c: McpClient = fakeClient({ content: [{ type: "text", text: "ok" }], isError: false }),
    serviceToken: string | undefined = "svc-token",
  ): void => {
    client = c;
    const binding: MCPServerBinding = { name: cr.metadata.name, cr, serviceToken };
    server = createMcpBrokerServer({
      auth: { orchestratorToken: "orch" },
      registry: new StaticMCPServerRegistry([binding]),
      client: c,
    });
    server.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(() => server?.close());

  const callTool = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer orch", ...(init.headers ?? {}) },
      body: init.body ?? JSON.stringify({ arguments: { q: "bug" } }),
      ...init,
    });

  describe("health and auth", () => {
    beforeEach(() => start(serverCR({})));

    it("serves health without a token", async () => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
    });

    it("rejects a missing or unknown bearer with 401", async () => {
      const noAuth = await fetch(`${base}/servers/github-mcp/tools/search_issues/call`, {
        method: "POST",
        body: JSON.stringify({ arguments: {} }),
      });
      expect(noAuth.status).toBe(401);

      const badAuth = await callTool("/servers/github-mcp/tools/search_issues/call", {
        headers: { authorization: "Bearer nope" },
      });
      expect(badAuth.status).toBe(401);
    });

    it("404s a non-POST or an unrecognized route", async () => {
      const get = await fetch(`${base}/servers/github-mcp/tools/search_issues/call`, {
        headers: { authorization: "Bearer orch" },
      });
      expect(get.status).toBe(404);
      const bad = await callTool("/servers/github-mcp/nope");
      expect(bad.status).toBe(404);
    });
  });

  describe("lookup", () => {
    it("404s an unknown server", async () => {
      start(serverCR({}));
      const res = await callTool("/servers/other/tools/search_issues/call");
      expect(res.status).toBe(404);
    });

    it("404s a tool that is not exposed, even if the server advertises it", async () => {
      // The operator's exposure map is truth for permission (§6): the broker
      // refuses to proxy a tool no exposure entry covers.
      start(serverCR({ expose: false }));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call");
      expect(res.status).toBe(404);
      expect(client.callTool).not.toHaveBeenCalled();
    });

    it("404s a tool name not in the exposure map at all", async () => {
      start(serverCR({}));
      const res = await callTool("/servers/github-mcp/tools/delete_repo/call");
      expect(res.status).toBe(404);
    });
  });

  describe("delegated-token fail-closed (§5)", () => {
    it("403s a per-user server when no delegated token is sent", async () => {
      start(serverCR({ identityProviders: ["github"] }));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call");
      expect(res.status).toBe(403);
      // Crucially, it did NOT fall back to the service credential.
      expect(client.callTool).not.toHaveBeenCalled();
      expect(((await res.json()) as { message: string }).message).toMatch(/delegated-token/);
    });

    it("spends the DELEGATED token for a per-user server", async () => {
      start(serverCR({ identityProviders: ["github"] }));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user-tok" },
      });
      expect(res.status).toBe(200);
      expect(client.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ token: "user-tok", name: "search_issues", arguments: { q: "bug" } }),
      );
    });

    it("spends the SERVICE credential for a server with no identityProviders", async () => {
      start(serverCR({}));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "ignored" },
      });
      expect(res.status).toBe(200);
      // A shared server spends the service token and ignores any forwarded user
      // token — identity does not matter to it.
      expect(client.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ token: "svc-token" }),
      );
    });
  });

  describe("result mapping", () => {
    it("flattens text content and passes isError through", async () => {
      start(
        serverCR({}),
        fakeClient({
          content: [
            { type: "text", text: "line 1\n" },
            { type: "text", text: "line 2" },
          ],
          isError: false,
        }),
      );
      const res = await callTool("/servers/github-mcp/tools/search_issues/call");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "line 1\nline 2", isError: false });
    });

    it("notes non-text content by its type and reports isError", async () => {
      start(
        serverCR({}),
        fakeClient({
          content: [
            { type: "text", text: "see image: " },
            { type: "image" },
          ],
          isError: true,
        }),
      );
      const res = await callTool("/servers/github-mcp/tools/search_issues/call");
      expect(await res.json()).toEqual({ result: "see image: [image]", isError: true });
    });

    it("502s a transport/protocol failure", async () => {
      start(serverCR({}), fakeClient(new McpTransportError("connection refused")));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call");
      expect(res.status).toBe(502);
      expect(((await res.json()) as { message: string }).message).toContain("connection refused");
    });

    it("tolerates a missing or malformed arguments body", async () => {
      start(serverCR({}));
      const res = await callTool("/servers/github-mcp/tools/search_issues/call", {
        body: "not json",
      });
      expect(res.status).toBe(200);
      expect(client.callTool).toHaveBeenCalledWith(expect.objectContaining({ arguments: {} }));
    });
  });
});
