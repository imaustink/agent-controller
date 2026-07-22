import { describe, expect, it, vi } from "vitest";
import { OidcTokenProvider } from "./oidc-token-provider.js";

function tokenResponse(token: string, expiresIn = 3600): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => ({ access_token: token, expires_in: expiresIn }) };
}

describe("OidcTokenProvider", () => {
  it("fetches a token via client_credentials on first use", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse("tok-1"));
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "integration-gateway",
      clientSecret: "s3cret",
      resource: "https://agent-orchestrator.internal",
      fetchImpl,
    });

    const token = await provider.getToken();

    expect(token).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://pocket-id.example.com/api/oidc/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("integration-gateway");
    expect(body.get("client_secret")).toBe("s3cret");
    expect(body.get("resource")).toBe("https://agent-orchestrator.internal");
  });

  it("returns the cached token without refetching while still valid", async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse("tok-1", 3600));
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("tok-1");
    now += 30 * 60 * 1000; // 30 minutes later, well within the 1h lifetime
    expect(await provider.getToken()).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cached token is within the refresh buffer of expiring", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1", 3600))
      .mockResolvedValueOnce(tokenResponse("tok-2", 3600));
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "c",
      clientSecret: "s",
      refreshBufferSeconds: 60,
      fetchImpl,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("tok-1");
    now += 3600 * 1000 - 30 * 1000; // 30s inside the 60s refresh buffer
    expect(await provider.getToken()).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent calls into a single in-flight request", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
    });

    const first = provider.getToken();
    const second = provider.getToken();
    resolveFetch(tokenResponse("tok-1"));

    expect(await first).toBe("tok-1");
    expect(await second).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when the token endpoint rejects the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "invalid_client" });
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "c",
      clientSecret: "wrong",
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow(/401/);
  });

  it("throws when the response is missing access_token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const provider = new OidcTokenProvider({
      tokenEndpoint: "https://pocket-id.example.com/api/oidc/token",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow(/access_token/);
  });
});
