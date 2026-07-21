import { describe, expect, it, vi } from "vitest";
import { IdentityLinkGatewayClient } from "./gateway-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("IdentityLinkGatewayClient", () => {
  it("start() posts subject and flow, and returns the device-flow start payload", async () => {
    const started = {
      flow: "device" as const,
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
      deviceCode: "raw-device-code",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, started));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway/", token: "tok", fetchImpl });

    const result = await client.start("github", "user-1", "device");

    expect(result).toEqual(started);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway/identity-link/github/start");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1", flow: "device" });
  });

  it("start() posts flow: authcode and passes through the authcode start payload as-is", async () => {
    const started = {
      flow: "authcode" as const,
      authorizeUrl: "https://github.com/login/oauth/authorize?state=xyz",
      expiresInSeconds: 600,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, started));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.start("github", "user-1", "authcode");

    expect(result).toEqual(started);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1", flow: "authcode" });
  });

  it.each(["pending", "complete", "expired", "denied"] as const)("poll() returns status %s", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status }));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.poll("github", "user-1", "device-code");

    expect(result).toBe(status);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway/identity-link/github/poll");
    expect(JSON.parse(init.body as string)).toEqual({ subject: "user-1", deviceCode: "device-code" });
  });

  it("getToken() returns the token on a 200", async () => {
    const token = { token: "gho_abc123", githubLogin: "octocat" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, token));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.getToken("github", "user-1");

    expect(result).toEqual(token);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://gateway/identity-link/github/token?subject=user-1");
  });

  it("getToken() returns undefined on a 404 (nothing linked yet)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    const result = await client.getToken("github", "user-1");

    expect(result).toBeUndefined();
  });

  it("start() throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    await expect(client.start("github", "user-1", "device")).rejects.toThrow(/500/);
  });

  it("poll() throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    await expect(client.poll("github", "user-1", "device-code")).rejects.toThrow(/500/);
  });

  it("getToken() throws on a non-2xx, non-404 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const client = new IdentityLinkGatewayClient({ baseUrl: "http://gateway", token: "tok", fetchImpl });

    await expect(client.getToken("github", "user-1")).rejects.toThrow(/500/);
  });
});
