import { describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "./orchestrator-client.js";

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

describe("OrchestratorClient.invoke", () => {
  it("posts /invoke then polls until succeeded", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "opened PR #7" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.invoke("do the thing", "github:acme/widgets#42");
    expect(result).toEqual({ status: "succeeded", result: "opened PR #7" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://orchestrator:8081/invoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ request: "do the thing", session_id: "github:acme/widgets#42" }),
      }),
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://orchestrator:8081/invoke/run-1");
  });

  it("resolves a function-provided token fresh on every request (e.g. OidcTokenProvider.getToken)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "done" }) });
    const getToken = vi.fn().mockResolvedValueOnce("tok-a").mockResolvedValueOnce("tok-b");

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: getToken,
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    await client.invoke("do the thing", "session-1");

    expect(getToken).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok-a" });
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok-b" });
  });

  it("omits identity_link_flow entirely when not passed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-4" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "done" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    await client.invoke("do the thing", "session-1");
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ request: "do the thing", session_id: "session-1" });
    expect(Object.keys(body)).not.toContain("identity_link_flow");
  });

  it("includes identity_link_flow when passed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-5" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "done" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    await client.invoke("do the thing", "session-1", "device");
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ request: "do the thing", session_id: "session-1", identity_link_flow: "device" });
  });

  it("surfaces a failed turn", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "failed", error: "boom" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    expect(await client.invoke("do the thing", "session-1")).toEqual({ status: "failed", error: "boom" });
  });

  it("returns failed when /invoke itself is rejected", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });
    const result = await client.invoke("do the thing", "session-1");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/401/);
  });

  it("times out if the turn never reaches a terminal state", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-3" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ status: "pending" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 10,
      pollTimeoutMs: 25,
      sleep: async () => {
        now += 10;
      },
      fetchImpl,
    });
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const result = await client.invoke("do the thing", "session-1");
    expect(result.status).toBe("timed_out");
    vi.restoreAllMocks();
  });
});

describe("OrchestratorClient.getSession", () => {
  it("fetches and returns the session view, authenticated with the same bearer token", async () => {
    const view = {
      sessionId: "github:acme/widgets#7",
      pending: false,
      transcript: [{ role: "user", text: "hi", at: 1 }],
    };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => view });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.getSession("github:acme/widgets#7");
    expect(result).toEqual(view);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator:8081/sessions/github%3Aacme%2Fwidgets%237",
      expect.objectContaining({ headers: { authorization: "Bearer tok" } }),
    );
  });

  it("returns undefined on a non-2xx response instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    expect(await client.getSession("unknown-session")).toBeUndefined();
  });
});
