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

  // resilience.e2e.ts's "recovers the reply on a follow-up turn after a
  // rollout" spec: a re-trigger posted right after `rollOrchestrator()` can
  // land in the brief window where the Service has no ready backend yet (old
  // pod terminating, new pod not Ready), which surfaces as `fetch` REJECTING
  // (ECONNREFUSED-style), not as a non-ok response. Every other failure path
  // in this method degrades to `{status:"failed"}`; a raw network exception
  // here instead propagated uncaught through runTurn's bare `try {} finally
  // {}` (no catch), silently dropping the whole turn -- no comment, no retry.
  // A transient connection failure this early should be retried, not treated
  // as final: the window a restarting Service is unreachable is seconds, well
  // inside a caller's own poll budget.
  it("retries the initial POST when it hits a network-level error, then succeeds once the pod is back", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "recovered reply" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.invoke("do the thing", "session-1");
    expect(result).toEqual({ status: "succeeded", result: "recovered reply" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  // The other half of the same rollout, and the one the accept retry above
  // does NOT cover. The pod exits ~1s after SIGTERM (`/invoke` answers 202
  // immediately, so the shutdown drain has nothing in flight to wait for)
  // while kube-proxy applies endpoint changes at most once a second, so a poll
  // sent into that gap reaches a dead address and the kernel waits out a
  // ~10.5s connect timeout instead of failing fast. Thrown from the poll it
  // escaped invoke() and runTurn() and no comment was ever posted -- which is
  // precisely "timed out waiting for a terminal comment" in resilience.e2e.ts.
  it("retries a poll that hits a network-level error, and finishes the turn once the pod is back", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockRejectedValueOnce(new Error("UND_ERR_CONNECT_TIMEOUT"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "survived the roll" }) });

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.invoke("do the thing", "session-1");
    expect(result).toEqual({ status: "succeeded", result: "survived the roll" });
  });

  // What the e2e spec actually accepts: the retried poll reaches the NEW pod,
  // which has never heard of this id and answers 404. A reported failure is a
  // comment; an escaped exception is silence.
  it("reports a poll that reaches a pod which no longer knows the turn, rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockRejectedValueOnce(new Error("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not found" });

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
    expect(result.error).toMatch(/404/);
  });

  // The relay, not the turn, is what bounds this. invoke() holds a gateway
  // relay for as long as it runs, and values-e2e.yaml shortens pollTimeoutMs
  // and resumeWaitMs specifically so an abandoned turn releases it promptly.
  // Retrying a dead orchestrator to the deadline honours the poll budget and
  // starves the NEXT turn -- trading a dropped turn for a stalled one, which
  // is what the first version of this retry actually did.
  it("gives up after a bounded number of poll failures rather than holding the relay for the whole budget", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockRejectedValue(new Error("UND_ERR_CONNECT_TIMEOUT"));

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      // Deliberately enormous: if this bounded the give-up, the call would make
      // hundreds of poll attempts instead of a handful.
      pollTimeoutMs: 10 * 60 * 1000,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.invoke("do the thing", "session-1");
    expect(result.status).toBe("failed");
    // 1 accept + a small, bounded number of polls.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("reports an unreachable poll distinctly from a turn that merely never finished", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-1" }) })
      .mockRejectedValue(new Error("UND_ERR_CONNECT_TIMEOUT"));

    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
      sleep: noopSleep,
      fetchImpl,
    });

    const result = await client.invoke("do the thing", "session-1");
    // "we never reached it" and "it never finished" have different fixes, and
    // the posted comment is the only place anyone sees either.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unreachable/);
    expect(result.error).toMatch(/UND_ERR_CONNECT_TIMEOUT/);
  });

  it("returns failed once the initial POST's network error outlasts the retry budget", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
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
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("fires onRunning once on the first non-identity-pending `pending` poll", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-r" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "opened PR #9" }) });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });
    const onRunning = vi.fn();

    const result = await client.invoke("do the thing", "session-1", "device", undefined, onRunning);

    expect(result.status).toBe("succeeded");
    expect(onRunning).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onRunning while the turn is identity-link-pending, and surfaces identityLinkPending + identityLink from the terminal poll", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-p" }) })
      // pending polls carry the early identity-link-pending signal (set before
      // the link URL exists), so onRunning must stay silent.
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending", identityLinkPending: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "succeeded",
          result: "To continue, please [link your Claude account](https://gw/claude-auth/x).",
          identityLinkPending: true,
          identityLink: { provider: "claude", subject: "client-integration-gateway" },
        }),
      });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });
    const onRunning = vi.fn();

    const result = await client.invoke("triage this", "session-1", "device", { source: "github" }, onRunning);

    expect(onRunning).not.toHaveBeenCalled();
    expect(result.identityLinkPending).toBe(true);
    expect(result.identityLink).toEqual({ provider: "claude", subject: "client-integration-gateway" });
    expect(result.result).toMatch(/link your Claude account/);
  });

  it("fires onRemoteControlUrl once when the poll body surfaces a remoteControlUrl", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-rc" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending", remoteControlUrl: "https://claude.ai/code/session_abc" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending", remoteControlUrl: "https://claude.ai/code/session_abc" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "opened PR #9" }) });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });
    const onRunning = vi.fn();
    const onRemoteControlUrl = vi.fn();

    const result = await client.invoke("do the thing", "session-1", "device", undefined, onRunning, onRemoteControlUrl);

    expect(result.status).toBe("succeeded");
    expect(onRemoteControlUrl).toHaveBeenCalledTimes(1);
    expect(onRemoteControlUrl).toHaveBeenCalledWith("https://claude.ai/code/session_abc");
  });

  it("never fires onRemoteControlUrl when the poll body never carries one (e.g. opencode-swe-agent runs)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "run-plain" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "succeeded", result: "opened PR #9" }) });
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
    });
    const onRemoteControlUrl = vi.fn();

    await client.invoke("do the thing", "session-1", "device", undefined, undefined, onRemoteControlUrl);

    expect(onRemoteControlUrl).not.toHaveBeenCalled();
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
