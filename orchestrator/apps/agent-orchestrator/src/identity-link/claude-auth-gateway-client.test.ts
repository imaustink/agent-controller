import { describe, expect, it, vi } from "vitest";
import { ClaudeAuthGatewayClient } from "./claude-auth-gateway-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("ClaudeAuthGatewayClient", () => {
  it("start() posts subject and returns a page-flow start payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { flowId: "flow-1", pageUrl: "https://gw.example/claude-auth/flow-1?u=..." }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway/", token: "tok", fetchImpl });

    const result = await client.start("claude", "user-1", "authcode");

    expect(result).toEqual({ flow: "page", pageUrl: "https://gw.example/claude-auth/flow-1?u=...", expiresInSeconds: 600 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway/claude-auth/api/start");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1" });
  });

  it("poll() throws -- unsupported for this provider", async () => {
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok" });
    await expect(client.poll()).rejects.toThrow(/not supported/);
  });

  it("getToken() returns the token on a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token: "sk-ant-oat01-abc" }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.getToken("claude", "user-1");

    expect(result).toEqual({ token: "sk-ant-oat01-abc" });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://gateway/claude-auth/api/token?subject=user-1");
  });

  it("getToken() returns undefined on a 404 (nothing linked yet)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    expect(await client.getToken("claude", "user-1")).toBeUndefined();
  });

  it("waitForCompletion() posts subject/timeoutMs and returns the token on completion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "complete", token: "sk-ant-oat01-abc" }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.waitForCompletion("claude", "user-1", 60_000);

    expect(result).toEqual({ token: "sk-ant-oat01-abc" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway/claude-auth/api/wait");
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1", timeoutMs: 60_000 });
  });

  it("waitForCompletion() returns undefined on a timeout response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "timeout" }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    expect(await client.waitForCompletion("claude", "user-1", 60_000)).toBeUndefined();
  });

  it("invalidate() posts subject", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ok" }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    await client.invalidate("claude", "user-1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway/claude-auth/api/invalidate");
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1" });
  });

  it("start() throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const client = new ClaudeAuthGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    await expect(client.start("claude", "user-1", "authcode")).rejects.toThrow(/500/);
  });
});
