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

describe("OrchestratorClient live-session tunnel (ADR 0026)", () => {
  it("checkLive reports live with the agent run id on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ live: true, agentRunId: "run-42" }) });
    const client = new OrchestratorClient({ baseUrl: "http://orchestrator:8081", token: "tok", pollIntervalMs: 1, pollTimeoutMs: 1000, fetchImpl });

    await expect(client.checkLive("github:acme/widgets#7")).resolves.toEqual({ live: true, agentRunId: "run-42" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator:8081/sessions/live?sessionId=github%3Aacme%2Fwidgets%237",
      expect.objectContaining({ headers: { authorization: "Bearer tok" } }),
    );
  });

  it("checkLive degrades to not-live on a non-ok response or a network error", async () => {
    const client1 = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }),
    });
    await expect(client1.checkLive("s1")).resolves.toEqual({ live: false });

    const client2 = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      fetchImpl: vi.fn().mockRejectedValueOnce(new Error("connection refused")),
    });
    await expect(client2.checkLive("s1")).resolves.toEqual({ live: false });
  });

  it("openEventStream requests the run's SSE endpoint with the sessionId cross-check and returns the raw response", async () => {
    const rawResponse = { ok: true } as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(rawResponse);
    const client = new OrchestratorClient({ baseUrl: "http://orchestrator:8081", token: "tok", pollIntervalMs: 1, pollTimeoutMs: 1000, fetchImpl });

    const result = await client.openEventStream("run-42", "github:acme/widgets#7");
    expect(result).toBe(rawResponse);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator:8081/agent-runs/run-42/events?sessionId=github%3Aacme%2Fwidgets%237",
      { headers: { authorization: "Bearer tok", accept: "text/event-stream" } },
    );
  });

  it("forwardOpencode posts the proxied request and returns the parsed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ status: 204 }) });
    const client = new OrchestratorClient({ baseUrl: "http://orchestrator:8081", token: "tok", pollIntervalMs: 1, pollTimeoutMs: 1000, fetchImpl });

    const result = await client.forwardOpencode("run-42", "github:acme/widgets#7", {
      method: "POST",
      path: "/session/ses_1/prompt_async",
      body: { parts: [{ type: "text", text: "continue" }] },
    });
    expect(result).toEqual({ status: 204 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://orchestrator:8081/agent-runs/run-42/opencode?sessionId=github%3Aacme%2Fwidgets%237",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ method: "POST", path: "/session/ses_1/prompt_async", body: { parts: [{ type: "text", text: "continue" }] } }),
      }),
    );
  });

  it("forwardOpencode throws on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 502, text: async () => "bad gateway" });
    const client = new OrchestratorClient({ baseUrl: "http://orchestrator:8081", token: "tok", pollIntervalMs: 1, pollTimeoutMs: 1000, fetchImpl });

    await expect(client.forwardOpencode("run-42", "s1", { method: "GET", path: "/session" })).rejects.toThrow(/502/);
  });
});
