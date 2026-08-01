import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForToken } from "./authCodeFlow.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildAuthorizeUrl", () => {
  it("includes client_id/redirect_uri/state/scope", () => {
    const url = buildAuthorizeUrl("client-id", "https://chat.example.com/callback", "the-state", "repo");
    expect(url).toBe(
      "https://github.com/login/oauth/authorize?" +
        "client_id=client-id&redirect_uri=https%3A%2F%2Fchat.example.com%2Fcallback&state=the-state&scope=repo",
    );
  });

  it("omits scope entirely when undefined", () => {
    const url = buildAuthorizeUrl("client-id", "https://chat.example.com/callback", "the-state", undefined);
    expect(url).toBe(
      "https://github.com/login/oauth/authorize?" +
        "client_id=client-id&redirect_uri=https%3A%2F%2Fchat.example.com%2Fcallback&state=the-state",
    );
    expect(url).not.toContain("scope");
  });

  it("supports a custom githubBaseUrl", () => {
    const url = buildAuthorizeUrl("client-id", "https://chat.example.com/callback", "state", undefined, "https://github.example.com");
    expect(url.startsWith("https://github.example.com/login/oauth/authorize?")).toBe(true);
  });
});

describe("exchangeCodeForToken", () => {
  const now = 1_700_000_000_000;

  it("POSTs the code grant and returns the computed token pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "ghu_abc123",
        token_type: "bearer",
        scope: "repo",
        refresh_token: "ghr_refresh456",
        refresh_token_expires_in: 15_897_600,
        expires_in: 28_800,
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForToken(
      "client-id",
      "client-secret",
      "the-code",
      "https://chat.example.com/callback",
      "https://github.com",
      now,
    );

    expect(result).toEqual({
      token: "ghu_abc123",
      refreshToken: "ghr_refresh456",
      expiresAt: new Date(now + 28_800 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 15_897_600 * 1000).toISOString(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
    const callBody = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(callBody.get("client_id")).toBe("client-id");
    expect(callBody.get("client_secret")).toBe("client-secret");
    expect(callBody.get("code")).toBe("the-code");
    expect(callBody.get("redirect_uri")).toBe("https://chat.example.com/callback");
  });

  it("throws with response detail on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad code" }),
    );
    await expect(
      exchangeCodeForToken("client-id", "client-secret", "bad-code", "https://chat.example.com/callback"),
    ).rejects.toThrow(/400.*bad code/s);
  });

  it("throws when GitHub returns a 200 with an error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }),
      }),
    );
    await expect(
      exchangeCodeForToken("client-id", "client-secret", "expired-code", "https://chat.example.com/callback"),
    ).rejects.toThrow(/bad_verification_code.*incorrect or expired/s);
  });
});
