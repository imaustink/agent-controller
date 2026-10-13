import { createHmac } from "node:crypto";
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

    const result = await client.invoke("do the thing", "session-1", "device", { onRunning });

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

    const result = await client.invoke("triage this", "session-1", "device", { onRunning });

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

    const result = await client.invoke("do the thing", "session-1", "device", { onRunning, onRemoteControlUrl });

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

    await client.invoke("do the thing", "session-1", "device", { onRemoteControlUrl });

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

  it("probeLive distinguishes live, confirmed not-live, and unknown (non-ok or network error)", async () => {
    const mk = (fetchImpl: typeof fetch) =>
      new OrchestratorClient({ baseUrl: "http://orchestrator:8081", token: "tok", pollIntervalMs: 1, pollTimeoutMs: 1000, fetchImpl });

    // A real 200 saying live -> "live" with the run id.
    await expect(
      mk(vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ live: true, agentRunId: "run-42" }) })).probeLive("s1"),
    ).resolves.toEqual({ status: "live", agentRunId: "run-42" });

    // A real 200 saying not-live -> CONFIRMED "not-live" (the positive terminal signal).
    await expect(
      mk(vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ live: false }) })).probeLive("s1"),
    ).resolves.toEqual({ status: "not-live" });

    // A non-ok response -> "unknown", NOT confirmed not-live.
    await expect(
      mk(vi.fn().mockResolvedValueOnce({ ok: false, status: 500 })).probeLive("s1"),
    ).resolves.toEqual({ status: "unknown" });

    // A rejected fetch (network error) -> "unknown".
    await expect(
      mk(vi.fn().mockRejectedValueOnce(new Error("connection refused"))).probeLive("s1"),
    ).resolves.toEqual({ status: "unknown" });
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

describe("OrchestratorClient.submitEvent (docs/event-triggers.md §5)", () => {
  const envelope = {
    source: "github",
    kind: "webhook" as const,
    id: "d-1",
    time: "2026-10-13T12:00:00Z",
    headers: { "x-github-event": "issues" },
    body: { action: "labeled" },
    sender: { login: "alice", isBot: false },
    repository: "acme/widgets",
  };
  const client = (fetchImpl: typeof fetch, senderAssertionSecret?: string): OrchestratorClient =>
    new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      sleep: noopSleep,
      fetchImpl,
      ...(senderAssertionSecret ? { senderAssertionSecret } : {}),
    });

  it("posts { event, identity_link_flow: device } and does NOT poll", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ignored" }), { status: 200 }));
    expect(await client(fetchImpl).submitEvent(envelope)).toEqual({ kind: "ignored" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ event: envelope, identity_link_flow: "device" });
  });

  it("maps 422 to rejected with the orchestrator's error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "failed", error: "param number: no such key" }), { status: 422 }));
    expect(await client(fetchImpl).submitEvent(envelope)).toEqual({ kind: "rejected", error: "param number: no such key" });
  });

  it("maps 202 to accepted with the trigger (reply already rendered)", async () => {
    const trigger = { name: "review", sessionId: "github:acme/widgets#7", reply: { github: { repository: "acme/widgets", issueNumber: 7 } } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "inv-1", status: "pending", trigger }), { status: 202 }));
    expect(await client(fetchImpl).submitEvent(envelope)).toEqual({ kind: "accepted", id: "inv-1", trigger });
  });

  it("treats any other answer as failed (never as accepted)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await client(fetchImpl).submitEvent(envelope)).toEqual({ kind: "failed", error: "/invoke answered 401: nope" });
  });

  it("signs a sender assertion only when given a verified login AND a secret", async () => {
    const ok = (): Response => new Response(JSON.stringify({ status: "ignored" }), { status: 200 });
    const headerOf = (f: ReturnType<typeof vi.fn>): string | undefined =>
      ((f.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)["x-gateway-user-assertion"];

    const withLogin = vi.fn().mockImplementation(async () => ok());
    await client(withLogin, "s3cret").submitEvent(envelope, "alice");
    const assertion = headerOf(withLogin);
    expect(assertion).toBeDefined();
    const [payload, sig] = assertion!.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")).login).toBe("alice");
    expect(sig).toBe(createHmac("sha256", "s3cret").update(payload!).digest("base64url"));

    // envelope.sender.login is present, but no VERIFIED login was passed: no assertion.
    const noLogin = vi.fn().mockImplementation(async () => ok());
    await client(noLogin, "s3cret").submitEvent(envelope);
    expect(headerOf(noLogin)).toBeUndefined();
  });
});
