import { describe, expect, it, vi } from "vitest";
import { TemporalEngine } from "./temporal-engine.js";
import { SENDER_ASSERTION_HEADER } from "../rbac/sender-assertion.js";
import { verifySenderAssertion } from "../rbac/sender-assertion.js";
import type { AgentGraphInput } from "../server.js";

const BASE = "http://temporal-engine-gateway:8080";

function input(overrides: Partial<AgentGraphInput> = {}): AgentGraphInput {
  return { request: "what pods are running?", authToken: "caller-token", ...overrides };
}

/** Scripts the accept/poll pair: one POST /invoke, then the given GET responses in order. */
function scriptedFetch(records: unknown[], accepted = { id: "conversation-abc.upd-1", status: "pending" }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let polls = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, ...(init ? { init } : {}) });
    if (href.endsWith("/invoke")) {
      return new Response(JSON.stringify(accepted), { status: 202 });
    }
    const body = records[Math.min(polls, records.length - 1)];
    polls++;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("TemporalEngine", () => {
  it("starts a turn and returns the result once the record settles", async () => {
    const { impl, calls } = scriptedFetch([
      { id: "x", status: "pending" },
      { id: "x", status: "succeeded", result: "three pods, all Running" },
    ]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const state = await engine.invoke(input());

    expect(state.result).toBe("three pods, all Running");
    expect(state.error).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/invoke`);
    expect(calls[1]!.url).toBe(`${BASE}/invoke/conversation-abc.upd-1`);
  });

  it("reports a failed turn as an error rather than an empty result", async () => {
    const { impl } = scriptedFetch([{ id: "x", status: "failed", error: "the planner exploded" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const state = await engine.invoke(input());
    expect(state.error).toBe("the planner exploded");
    expect(state.result).toBeUndefined();
  });

  // The second non-error terminal shape (docs/adr/0035) has to survive this hop,
  // or a caller offering its own tools would get an empty success.
  it("carries pending caller tool calls through", async () => {
    const { impl } = scriptedFetch([
      {
        id: "x",
        status: "succeeded",
        toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"x"}' }],
      },
    ]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const state = await engine.invoke(input());
    expect(state.pendingToolCalls).toEqual([{ id: "call_1", name: "web_search", arguments: '{"query":"x"}' }]);
    expect(state.result).toBeUndefined();
  });

  // This process owns the route registry and has already matched it. Re-deriving
  // the target in the engine would put routing policy in two places.
  it("names an already-matched route target instead of resending the event", async () => {
    const { impl, calls } = scriptedFetch([{ id: "x", status: "succeeded", result: "triaged" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    await engine.invoke(input({ forcedAgentId: "claude-code-swe-agent", sessionId: "github:acme/widgets#7" }));

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.forcedAgentId).toBe("claude-code-swe-agent");
    expect(body.sessionId).toBe("github:acme/widgets#7");
    expect(body.event).toBeUndefined();
  });

  // The sender login selects which stored credentials a run receives, so an
  // internal hop is exactly as unsuited to trusting it unsigned as an external
  // one. Signed with the same contract integration-gateway uses.
  it("signs the sender login rather than sending it as a body field", async () => {
    const secret = "shared-with-integration-gateway";
    const { impl, calls } = scriptedFetch([{ id: "x", status: "succeeded", result: "ok" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl, senderAssertionSecret: secret });

    await engine.invoke(input({ senderLogin: "imaustink" }));

    const headers = calls[0]!.init!.headers as Record<string, string>;
    const assertion = headers[SENDER_ASSERTION_HEADER];
    expect(assertion).toBeDefined();
    expect(verifySenderAssertion(secret, assertion)).toBe("imaustink");

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.senderLogin).toBeUndefined();
  });

  it("omits the assertion when no secret is configured", async () => {
    const { impl, calls } = scriptedFetch([{ id: "x", status: "succeeded", result: "ok" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    await engine.invoke(input({ senderLogin: "imaustink" }));
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers[SENDER_ASSERTION_HEADER]).toBeUndefined();
  });

  // A turn that outlives the poll budget is NOT lost: the record is the
  // workflow, not this process's memory, so the answer stays collectable. It is
  // reported as a resumable pause rather than a failure — the same shape ADR
  // 0033 settled on for an interrupted turn.
  it("reports a resumable pause rather than an error when it stops waiting", async () => {
    const { impl } = scriptedFetch([{ id: "x", status: "pending" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl, timeoutMs: 0 });

    const state = await engine.invoke(input());
    expect(state.error).toBeUndefined();
    expect(state.result).toContain("still running");
  });

  it("throws when the engine is unreachable, so the turn fails honestly", async () => {
    const impl = vi.fn(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    await expect(engine.invoke(input())).rejects.toThrow(/502/);
  });

  // The returned AsyncIterable itself still only ever yields one terminal
  // update -- there are no LangGraph node transitions on this engine to
  // report as separate updates. Live narration during the wait rides a
  // different channel: progressListener, called as a side effect from
  // poll() below, which is what a streaming caller's SSE writer actually
  // listens to (see handleChatCompletionsStreaming).
  it("streams a single terminal update", async () => {
    const { impl } = scriptedFetch([{ id: "x", status: "succeeded", result: "done" }]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const updates: Record<string, unknown>[] = [];
    for await (const update of await engine.stream(input(), { streamMode: "updates" })) {
      updates.push(update);
    }
    expect(updates).toHaveLength(1);
    expect(Object.values(updates[0]!)[0]).toMatchObject({ result: "done" });
  });

  // Regression: stream() used to `await this.invoke(input)` before returning
  // the iterable, so its own Promise didn't settle until the whole turn had
  // already finished. That left server.ts's withHeartbeat wrapper unable to
  // do its job -- it can't race a source it doesn't have yet -- so a
  // long-running turn's SSE connection had no keep-alive bytes at all and an
  // idle-connection timeout upstream would cancel it even though the turn
  // kept running server-side. stream() must resolve immediately; only
  // iterating it should trigger the poll loop.
  it("resolves the streamed iterable before the turn finishes polling", async () => {
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    let released = false;
    const impl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/invoke")) {
        return new Response(JSON.stringify({ id: "x", status: "pending" }), { status: 202 });
      }
      await pending; // the turn "hangs" here until the test releases it
      released = true;
      return new Response(JSON.stringify({ id: "x", status: "succeeded", result: "done" }), { status: 200 });
    }) as unknown as typeof fetch;
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const streamPromise = engine.stream(input(), { streamMode: "updates" });
    const source = await Promise.race([
      streamPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream() did not resolve promptly")), 50)),
    ]);
    expect(released).toBe(false); // the turn is still in-flight

    const updates: Record<string, unknown>[] = [];
    const drained = (async () => {
      for await (const update of source as AsyncIterable<Record<string, unknown>>) updates.push(update);
    })();
    resolvePending();
    await drained;
    expect(updates).toHaveLength(1);
    expect(Object.values(updates[0]!)[0]).toMatchObject({ result: "done" });
  });

  // Without this, a streaming chat caller on this engine saw nothing at all
  // until the whole turn completed -- poll() ran silently, even though the
  // engine's own gateway already narrates in-flight turns
  // (workflows.TurnProgressQuery) for its native SSE endpoint. This is that
  // same narration relayed through the accept/poll /invoke contract instead.
  it("relays in-flight progress lines to progressListener as they arrive, without repeating them", async () => {
    const { impl } = scriptedFetch([
      { id: "x", status: "pending", progress: ["clone: cloning the repo"] },
      { id: "x", status: "pending", progress: ["clone: cloning the repo", "edit: adding the README"] },
      { id: "x", status: "succeeded", result: "Opened PR #1" },
    ]);
    const progressListener = vi.fn();
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    const state = await engine.invoke(input({ progressListener }));

    expect(state.result).toBe("Opened PR #1");
    expect(progressListener).toHaveBeenCalledTimes(2);
    expect(progressListener).toHaveBeenNthCalledWith(1, "", "clone: cloning the repo");
    expect(progressListener).toHaveBeenNthCalledWith(2, "", "edit: adding the README");
  });

  it("un-flattens agent-text/identity-link/remote-control-url narration lines back into their stage, so server.ts streams them as real content instead of a truncated status label", async () => {
    const { impl } = scriptedFetch([
      {
        id: "x",
        status: "pending",
        progress: [
          "agent-text: Sure, here's the ",
          "agent-text: Sure, here's the fix",
          "identity-link: https://example.com/link",
          "remote-control-url: https://example.com/rc",
          "clone: cloning the repo",
        ],
      },
      { id: "x", status: "succeeded", result: "done" },
    ]);
    const progressListener = vi.fn();
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    await engine.invoke(input({ progressListener }));

    expect(progressListener).toHaveBeenNthCalledWith(1, "agent-text", "Sure, here's the ");
    expect(progressListener).toHaveBeenNthCalledWith(2, "agent-text", "Sure, here's the fix");
    expect(progressListener).toHaveBeenNthCalledWith(3, "identity-link", "https://example.com/link");
    expect(progressListener).toHaveBeenNthCalledWith(4, "remote-control-url", "https://example.com/rc");
    expect(progressListener).toHaveBeenNthCalledWith(5, "", "clone: cloning the repo");
  });

  it("never calls progressListener when the caller has no live channel", async () => {
    const { impl } = scriptedFetch([
      { id: "x", status: "pending", progress: ["clone: cloning the repo"] },
      { id: "x", status: "succeeded", result: "Opened PR #1" },
    ]);
    const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl });

    // input() sets no progressListener -- this must not throw reading it,
    // and there is nothing to assert a call against.
    await expect(engine.invoke(input())).resolves.toMatchObject({ result: "Opened PR #1" });
  });

  describe("auto-resuming a parked identity link", () => {
    // Two /invoke POSTs total: the original turn, and ONE resume. Each
    // scriptedFetch() call below only needs one GET record per turn because
    // Authorize's own wait is short (a non-live poll settles immediately),
    // so the SECOND turn's own poll() loop never sees "pending" either.
    it("re-submits automatically and surfaces the eventual result, without repeating the prompt", async () => {
      const { impl, calls } = scriptedFetch([
        { id: "x", status: "succeeded", result: "To continue, please link your GitHub account...", path: "link-required" },
        { id: "x", status: "succeeded", result: "Opened PR #42." },
      ]);
      const progressListener = vi.fn();
      const engine = new TemporalEngine({
        baseUrl: BASE,
        fetchImpl: impl,
        autoResumeIntervalMs: 1,
      });

      const state = await engine.invoke(input({ progressListener, sessionId: "chat-1" }));

      expect(state.result).toBe("Opened PR #42.");
      // The prompt was shown exactly once, as real content -- not
      // suppressed, and not repeated on every silent nudge.
      expect(progressListener).toHaveBeenCalledTimes(1);
      expect(progressListener).toHaveBeenCalledWith("identity-link", "To continue, please link your GitHub account...");
      // One POST /invoke for the original turn, one for the single resume.
      expect(calls.filter((c) => c.url === `${BASE}/invoke`)).toHaveLength(2);
    });

    it("does not auto-resume a caller with no live channel (a webhook/triage relay)", async () => {
      const { impl, calls } = scriptedFetch([
        { id: "x", status: "succeeded", result: "To continue, please link your GitHub account...", path: "link-required" },
      ]);
      const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl, autoResumeIntervalMs: 1 });

      // No progressListener -- input()'s default -- so this must return the
      // link-required reply immediately: ADR 0006 requires a relayed turn
      // to return right away rather than block waiting on a human.
      const state = await engine.invoke(input({ sessionId: "chat-1" }));

      expect(state.result).toBe("To continue, please link your GitHub account...");
      expect(calls.filter((c) => c.url === `${BASE}/invoke`)).toHaveLength(1);
    });

    it("does not auto-resume without a stable session id to resume", async () => {
      const { impl, calls } = scriptedFetch([
        { id: "x", status: "succeeded", result: "To continue, please link your GitHub account...", path: "link-required" },
      ]);
      const progressListener = vi.fn();
      const engine = new TemporalEngine({ baseUrl: BASE, fetchImpl: impl, autoResumeIntervalMs: 1 });

      // A live channel alone isn't enough -- resuming means re-submitting to
      // the SAME conversation workflow, which requires a session id.
      const state = await engine.invoke(input({ progressListener }));

      expect(state.result).toBe("To continue, please link your GitHub account...");
      expect(progressListener).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.url === `${BASE}/invoke`)).toHaveLength(1);
    });

    it("gives up after its own deadline without repeating the original prompt", async () => {
      const { impl } = scriptedFetch([
        { id: "x", status: "succeeded", result: "To continue, please link your GitHub account...", path: "link-required" },
      ]);
      const progressListener = vi.fn();
      const engine = new TemporalEngine({
        baseUrl: BASE,
        fetchImpl: impl,
        autoResumeIntervalMs: 1,
        autoResumeMaxMs: 1,
      });

      const state = await engine.invoke(input({ progressListener, sessionId: "chat-1" }));

      expect(state.result).toContain("Still waiting for you to finish linking");
      expect(state.result).not.toContain("please link your GitHub account");
      expect(progressListener).toHaveBeenCalledTimes(1);
    });
  });
});
