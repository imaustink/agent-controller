import { afterEach, describe, expect, it, vi } from "vitest";
import { pollDeviceFlow, refreshUserToken, startDeviceFlow } from "./deviceFlow.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startDeviceFlow", () => {
  it("POSTs client_id/scope form-encoded and returns the device/user code pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: "devcode123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await startDeviceFlow("client-id", "repo");

    expect(result).toEqual({
      deviceCode: "devcode123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({ method: "POST" }),
    );
    const callBody = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(callBody.get("client_id")).toBe("client-id");
    expect(callBody.get("scope")).toBe("repo");
  });

  it("throws with response detail on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad client_id" }),
    );
    await expect(startDeviceFlow("bad-client", undefined)).rejects.toThrow(/400.*bad client_id/s);
  });
});

describe("pollDeviceFlow", () => {
  const now = 1_700_000_000_000;

  it("returns complete with computed expiresAt/refreshExpiresAt on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
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
      }),
    );

    const result = await pollDeviceFlow("client-id", "devcode123", "https://github.com", now);

    expect(result).toEqual({
      status: "complete",
      token: "ghu_abc123",
      refreshToken: "ghr_refresh456",
      expiresAt: new Date(now + 28_800 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 15_897_600 * 1000).toISOString(),
    });
  });

  it("returns pending on authorization_pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: "authorization_pending" }) }),
    );
    const result = await pollDeviceFlow("client-id", "devcode123", "https://github.com", now);
    expect(result).toEqual({ status: "pending" });
  });

  it("returns slow_down with the new interval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: "slow_down", interval: 10 }),
      }),
    );
    const result = await pollDeviceFlow("client-id", "devcode123", "https://github.com", now);
    expect(result).toEqual({ status: "slow_down", retryAfterSeconds: 10 });
  });

  it("returns expired on expired_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: "expired_token" }) }),
    );
    const result = await pollDeviceFlow("client-id", "devcode123", "https://github.com", now);
    expect(result).toEqual({ status: "expired" });
  });

  it("returns denied on access_denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: "access_denied" }) }),
    );
    const result = await pollDeviceFlow("client-id", "devcode123", "https://github.com", now);
    expect(result).toEqual({ status: "denied" });
  });
});

describe("refreshUserToken", () => {
  const now = 1_700_000_000_000;

  it("POSTs the refresh_token grant and returns the rotated token pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "ghu_newtoken",
        refresh_token: "ghr_newrefresh",
        refresh_token_expires_in: 15_897_600,
        expires_in: 28_800,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshUserToken("client-id", "ghr_oldrefresh", "https://github.com", now);

    expect(result).toEqual({
      token: "ghu_newtoken",
      refreshToken: "ghr_newrefresh",
      expiresAt: new Date(now + 28_800 * 1000).toISOString(),
      refreshExpiresAt: new Date(now + 15_897_600 * 1000).toISOString(),
    });
    const callBody = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(callBody.get("grant_type")).toBe("refresh_token");
    expect(callBody.get("refresh_token")).toBe("ghr_oldrefresh");
  });

  it("throws on an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: "bad_refresh_token" }) }),
    );
    await expect(refreshUserToken("client-id", "ghr_expired", "https://github.com", now)).rejects.toThrow(
      /bad_refresh_token/,
    );
  });
});
