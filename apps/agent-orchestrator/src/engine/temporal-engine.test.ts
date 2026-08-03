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

  // Streaming yields the answer but no per-node narration: those lines describe
  // LangGraph node transitions, which do not exist on this engine.
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
});
