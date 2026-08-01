import { describe, expect, it, vi } from "vitest";
import { SENDER_ASSERTION_HEADER, mintSenderAssertion } from "./rbac/sender-assertion.js";
import { InvokeServer, type AgentGraphLike } from "./server.js";
import type { AgentState } from "./agent/graph.js";
import type { AgentOrchestratorChannel } from "./agents/nats-agent-channel.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";

/**
 * Every request in this file goes over a fresh TCP connection.
 *
 * Without this the suite failed roughly one run in ten, always as
 * `TypeError: fetch failed` / `SocketError: other side closed` on a request to a
 * server that had just started -- with `bytesWritten: 339, bytesRead: 0`, i.e.
 * the request was written to a socket whose peer had already gone. Nothing was
 * wrong with the server: it is connection REUSE across tests.
 *
 * Node's `fetch` (undici) keeps a keep-alive pool keyed by origin
 * (`127.0.0.1:<port>`) for several seconds. Each test here listens on port 0,
 * gets an ephemeral port, and closes the server when it finishes -- so under
 * load, when the OS recycles an ephemeral port quickly enough, a later test's
 * server can land on a port whose pooled (and now dead) socket is still cached.
 * The next request to that origin is handed the corpse.
 *
 * `connection: close` opts every request out of pooling, so there is never a
 * cached socket to inherit. Verified: three requests to one origin open three
 * sockets with this header and reuse one without it. Declared at module scope so
 * it shadows the global for the whole file -- no call site has to remember.
 */
const nativeFetch = globalThis.fetch;
const fetch: typeof globalThis.fetch = (input, init = {}) => {
  // Via the Headers API rather than an object spread, so a caller passing
  // Headers or an entry array keeps its headers instead of losing them.
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return nativeFetch(input, { ...init, headers });
};

function listenOn(server: InvokeServer): Promise<number> {
  return server.listen(0).then(() => {
    const address = server["server"]?.address();
    return typeof address === "object" && address ? address.port : 0;
  });
}

/** Default no-op stream so tests that only exercise /invoke don't need to stub it explicitly. */
async function* noStream(): AsyncGenerator<Record<string, Partial<AgentState>>> {
  // empty
}

async function* toStream(
  items: Record<string, Partial<AgentState>>[],
): AsyncGenerator<Record<string, Partial<AgentState>>> {
  for (const item of items) yield item;
}

async function readSse(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
}

describe("InvokeServer", () => {
  it("accepts a request, returns 202 + id, and the result becomes available once the graph resolves", async () => {
    let resolveGraph!: (state: AgentState) => void;
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockReturnValue(new Promise<AgentState>((resolve) => (resolveGraph = resolve))),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "scrape https://example.com/recipe" }),
    });
    expect(postRes.status).toBe(202);
    const { id, status } = (await postRes.json()) as { id: string; status: string };
    expect(status).toBe("pending");
    expect(graph.invoke).toHaveBeenCalledWith({
      request: "scrape https://example.com/recipe",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
    });

    const pendingRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect(pendingRes.status).toBe(200);
    expect((await pendingRes.json()) as { status: string }).toMatchObject({ status: "pending" });

    resolveGraph({ request: "x", authToken: "tok-1", skillCandidates: [], result: { title: "Pancakes" } } as AgentState);
    await new Promise((r) => setTimeout(r, 10));

    const doneRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect((await doneRes.json()) as { status: string; result: unknown }).toMatchObject({
      status: "succeeded",
      result: { title: "Pancakes" },
    });

    await server.close();
  });

  it("surfaces remoteControlUrl on GET /invoke/:id once a 'remote-control-url' progress event lands, and carries it through to the terminal response", async () => {
    let resolveGraph!: (state: AgentState) => void;
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockImplementation((input: { remoteControlUrlListener?: (url: string) => void }) => {
        // Simulate the delegate node forwarding a remote-control-url event --
        // this fire-and-forget /invoke path never sets `progressListener`
        // (see server.ts's doc on why), only `remoteControlUrlListener`.
        input.remoteControlUrlListener?.("https://claude.ai/code/session_abc123");
        return new Promise<AgentState>((resolve) => (resolveGraph = resolve));
      }),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "triage this", event: { source: "github" } }),
    });
    const { id } = (await postRes.json()) as { id: string };

    const pendingRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect((await pendingRes.json()) as { remoteControlUrl?: string }).toMatchObject({
      status: "pending",
      remoteControlUrl: "https://claude.ai/code/session_abc123",
    });

    resolveGraph({ request: "x", authToken: "tok-1", skillCandidates: [], result: "opened PR #7" } as AgentState);
    await new Promise((r) => setTimeout(r, 10));

    const doneRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect((await doneRes.json()) as { status: string; remoteControlUrl?: string }).toMatchObject({
      status: "succeeded",
      remoteControlUrl: "https://claude.ai/code/session_abc123",
    });

    await server.close();
  });

  it("omits remoteControlUrl entirely when no 'remote-control-url' progress event ever arrives", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "tok-1", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR" }),
    });
    const { id } = (await postRes.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 10));

    const doneRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    const body = (await doneRes.json()) as Record<string, unknown>;
    expect(body.status).toBe("succeeded");
    expect(Object.keys(body)).not.toContain("remoteControlUrl");

    await server.close();
  });

  it("marks the invocation failed when the graph settles with a state error", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "", skillCandidates: [], error: "no matching skill for this request" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "do a thing" }),
    });
    const { id } = (await postRes.json()) as { id: string };
    expect(graph.invoke).toHaveBeenCalledWith({
      request: "do a thing",
      authToken: "",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
    });

    await new Promise((r) => setTimeout(r, 10));
    const res = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect((await res.json()) as { status: string; error: string }).toMatchObject({
      status: "failed",
      error: "no matching skill for this request",
    });

    await server.close();
  });

  it("rejects a missing/invalid body with 400 without invoking the graph", async () => {
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(graph.invoke).not.toHaveBeenCalled();

    await server.close();
  });

  it("returns 404 for an unknown invocation id", async () => {
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/invoke/does-not-exist`);
    expect(res.status).toBe(404);

    await server.close();
  });

  /**
   * `buildGraphInput` awaits `sessionStore.get` before the graph ever runs
   * (see server.ts) -- a Redis blip there rejects that promise before the
   * `this.graph.invoke(...).catch(...)` chain even exists to catch it. Left
   * unhandled, that crashes the process, wiping every other in-flight
   * invocation and turning their polls into "poll failed: 404" for the
   * caller. This asserts the record still resolves to "failed" instead.
   */
  it("marks the invocation failed (not an unhandled rejection) when buildGraphInput itself rejects", async () => {
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const failingSessionStore = {
      get: vi.fn().mockRejectedValue(new Error("redis: connection reset")),
      set: vi.fn(),
    };
    const server = new InvokeServer(graph, failingSessionStore as unknown as InMemorySessionStore);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "do a thing", session_id: "session-1" }),
    });
    const { id } = (await postRes.json()) as { id: string };

    await new Promise((r) => setTimeout(r, 10));
    const res = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string; error: string }).toMatchObject({
      status: "failed",
      error: "redis: connection reset",
    });
    expect(graph.invoke).not.toHaveBeenCalled();

    await server.close();
  });
});

describe("InvokeServer /invoke event field -> IntegrationRoute dispatch (ADR 0024)", () => {
  async function routeRegistry(routes: unknown[]) {
    const { CrdIntegrationRouteRegistry } = await import("./routing/crd-integration-route-registry.js");
    const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: routes }),
    });
    await registry.listAll();
    return registry;
  }

  const labeledRouteCr = {
    metadata: { name: "github-issue-labeled-triage" },
    spec: {
      match: { source: "github", event: "issues", action: "labeled" },
      agentRef: "opencode-swe-agent",
      promptTemplate: "Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}",
    },
  };

  it("renders the matched route's promptTemplate and forces the target, bypassing the fallback request text", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph, undefined, undefined, await routeRegistry([labeledRouteCr]));
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: "fallback text (should be overridden)",
        session_id: "github:acme/widgets#7",
        event: {
          source: "github",
          event: "issues",
          action: "labeled",
          owner: "acme",
          repo: "widgets",
          issueNumber: 7,
          title: "Add dark mode",
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "Triage acme/widgets#7: Add dark mode",
        forcedAgentId: "opencode-swe-agent",
      }),
    );

    await server.close();
  });

  it("falls back to the plain request and no forced ids when the event doesn't match any route", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph, undefined, undefined, await routeRegistry([labeledRouteCr]));
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: "please review this",
        event: { source: "github", event: "issues", action: "opened" },
      }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({ request: "please review this" }));
    const invokedInput = (graph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(invokedInput.forcedAgentId).toBeUndefined();
    expect(invokedInput.forcedSkillId).toBeUndefined();

    await server.close();
  });

  it("ignores the event field entirely when no IntegrationRoute registry is configured", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph); // no registry passed
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: "please review this",
        event: { source: "github", event: "issues", action: "labeled" },
      }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({ request: "please review this" }));

    await server.close();
  });
});

describe("InvokeServer session-scoped pending identity link (GitHub OAuth Device Flow)", () => {
  function sessionStore() {
    return new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
  }

  /**
   * A turn that lost its channel to a still-working run must leave the
   * awaiting-reply anchor behind. The default for a turn that produced no reply
   * is to CLEAR the active-run state (the run concluded), which for this case
   * would throw away the only pointer back to a run that is still holding the
   * answer.
   */
  it("keeps the awaiting-reply anchor when the turn ended with a lost channel", async () => {
    const identity = { subject: "alice", roles: ["reader"] };
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        selectedAgent: { id: "claude-code-swe" },
        agentRunId: "run-1",
        agentAwaitingReply: false,
        agentResumePending: true,
        result: "Still working -- I lost my connection to agent run `run-1`.",
      } as unknown as AgentState),
      stream: vi.fn(),
    };
    const store = sessionStore();
    const server = new InvokeServer(graph, store);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "fix the bug", session_id: "session-1" }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(await store.get("session-1")).toMatchObject({
      subject: "alice",
      activeAgentId: "claude-code-swe",
      activeAgentRunId: "run-1",
      activeAgentRunAwaitingReply: true,
    });

    await server.close();
  });

  it("clears the anchor once the agent actually replies", async () => {
    const identity = { subject: "alice", roles: ["reader"] };
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        selectedAgent: { id: "claude-code-swe" },
        agentRunId: "run-1",
        agentAwaitingReply: false,
        result: "opened a PR",
      } as unknown as AgentState),
      stream: vi.fn(),
    };
    const store = sessionStore();
    await store.set("session-1", {
      subject: "alice",
      activeAgentId: "claude-code-swe",
      activeAgentRunId: "run-1",
      activeAgentRunAwaitingReply: true,
    });
    const server = new InvokeServer(graph, store);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "any update?", session_id: "session-1" }),
    });
    await new Promise((r) => setTimeout(r, 10));

    const record = await store.get("session-1");
    expect(record?.activeAgentRunId).toBeUndefined();
    expect(record?.activeAgentRunAwaitingReply).toBeUndefined();

    await server.close();
  });

  it("persists pendingIdentityLink from a turn that paused on device-flow authorization, and offers it to the graph on the next turn", async () => {
    const identity = { subject: "alice", roles: ["reader"] };
    const pendingIdentityLink = {
      agentId: "opencode-swe",
      provider: "github",
      deviceCode: "raw-device-code",
      expiresAt: Date.now() + 900_000,
    };
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        pendingIdentityLink,
        identityLinkPending: true,
        result: "please link your GitHub account",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR", session_id: "session-1" }),
    });
    const { id } = (await postRes.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 10));
    const doneRes = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
    expect((await doneRes.json()) as { status: string }).toMatchObject({ status: "succeeded" });

    // Second turn: the session should now offer the pending link back to the graph.
    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "any message", session_id: "session-1" }),
    });

    expect(graph.invoke).toHaveBeenNthCalledWith(2, {
      request: "any message",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
      sessionId: "session-1",
      activeSkillId: undefined,
      activeAgentId: undefined,
      activeAgentRunId: undefined,
      sessionSubject: "alice",
      toolContinuations: undefined,
      agentContinuations: undefined,
      pendingIdentityLink,
    });

    await server.close();
  });
});

describe("InvokeServer OpenAI-compatible chat completions (ADR 0007)", () => {
  it("GET /v1/models lists a single model id", async () => {
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toContain("agent-orchestrator");

    await server.close();
  });

  it("POST /v1/chat/completions (non-streaming) returns a chat.completion with the rendered result", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "scrape https://example.com",
        authToken: "tok-1",
        skillCandidates: [],
        result: { title: "Pancakes" },
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        model: "agent-orchestrator",
        messages: [{ role: "user", content: "scrape https://example.com" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(graph.invoke).toHaveBeenCalledWith({ request: "scrape https://example.com", authToken: "tok-1" });
    const body = (await res.json()) as { object: string; choices: { message: { content: string } }[] };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toContain("Pancakes");

    await server.close();
  });

  it("POST /v1/chat/completions forwards Open WebUI's per-user signed JWT header to the graph (non-streaming)", async () => {
    // Regression test: authToken alone is Open WebUI's single static bearer
    // token, shared by every one of its users -- the X-OpenWebUI-User-Jwt
    // header must reach the graph as forwardedUserToken so resolveIdentity
    // can resolve each human to their own subject instead.
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "scrape https://example.com",
        authToken: "tok-1",
        skillCandidates: [],
        result: { title: "Pancakes" },
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "x-openwebui-user-jwt": "alices-signed-jwt",
      },
      body: JSON.stringify({
        model: "agent-orchestrator",
        messages: [{ role: "user", content: "scrape https://example.com" }],
      }),
    });

    expect(graph.invoke).toHaveBeenCalledWith({
      request: "scrape https://example.com",
      authToken: "tok-1",
      forwardedUserToken: "alices-signed-jwt",
    });

    await server.close();
  });

  it("POST /v1/chat/completions omits forwardedUserToken when Open WebUI sends no such header", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "scrape https://example.com",
        authToken: "tok-1",
        skillCandidates: [],
        result: { title: "Pancakes" },
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        model: "agent-orchestrator",
        messages: [{ role: "user", content: "scrape https://example.com" }],
      }),
    });

    expect(graph.invoke).toHaveBeenCalledWith({ request: "scrape https://example.com", authToken: "tok-1" });

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) forwards Open WebUI's per-user signed JWT header to the graph", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(toStream([{ composeResponse: { result: "done" } }])),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "x-openwebui-user-jwt": "alices-signed-jwt",
      },
      body: JSON.stringify({
        model: "agent-orchestrator",
        stream: true,
        messages: [{ role: "user", content: "scrape https://example.com" }],
      }),
    });

    expect(graph.stream).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: "tok-1", forwardedUserToken: "alices-signed-jwt" }),
      { streamMode: "updates" },
    );

    await server.close();
  });

  it("POST /v1/chat/completions folds prior conversation turns (e.g. a previously extracted recipe) into the request instead of discarding them", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        result: "Published!",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Extract this recipe: https://example.com/recipe" },
          { role: "assistant", content: "# Pancakes\n\n## Ingredients\n- Flour" },
          { role: "user", content: "publish it!" },
        ],
      }),
    });

    expect(graph.invoke).toHaveBeenCalledWith({
      request:
        '<conversation_history>\n<message role="user">\nExtract this recipe: https://example.com/recipe\n</message>\n<message role="assistant">\n# Pancakes\n\n## Ingredients\n- Flour\n</message>\n</conversation_history>\n\npublish it!',
      authToken: "tok-1",
    });

    await server.close();
  });

  it("POST /v1/chat/completions keeps a recipe the USER pasted (not assistant-produced) visible on the next turn", async () => {
    // Regression: the fold used to include only the most recent assistant
    // message, so a user-pasted recipe was silently discarded when the next
    // turn was just "Let's publish it" — the planner then claimed the recipe
    // was missing from the conversation history.
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        result: "Published!",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "# Kentucky Butter Cake\n\n## Ingredients\n- Butter" },
          { role: "assistant", content: "What changes would you like to make?" },
          { role: "user", content: "Let's publish it" },
        ],
      }),
    });

    const request = (graph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0].request as string;
    expect(request).toContain("# Kentucky Butter Cake");
    expect(request).toContain('<message role="user">');
    expect(request).toContain("What changes would you like to make?");
    expect(request.endsWith("Let's publish it")).toBe(true);

    await server.close();
  });

  it("POST /v1/chat/completions (non-streaming) maps a graph error to an OpenAI-shaped HTTP error", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "",
        skillCandidates: [],
        error: "unauthorized: could not resolve caller identity",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "do a thing" }] }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");

    await server.close();
  });

  it("rejects a request with no user message, without invoking the graph", async () => {
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: "be nice" }] }),
    });

    expect(res.status).toBe(400);
    expect(graph.invoke).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) emits per-node status chunks then the final result over SSE", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(
        toStream([
          { resolveIdentity: { identity: { subject: "alice", roles: ["reader"] } } },
          {
            retrieveSkills: {
              skillCandidates: [
                { skill: { id: "recipe-publisher-skill" }, score: 0.9 } as AgentState["skillCandidates"][number],
              ],
            },
          },
          { selectSkill: { selectedSkill: { id: "recipe-publisher-skill", name: "Recipe Extraction & Publishing" } as AgentState["selectedSkill"] } },
          { loadSkillTools: { skillTools: [{ id: "recipe-scraper", name: "recipe-scraper" }] as AgentState["skillTools"] } },
          { planAction: { selectedTool: { id: "recipe-scraper", name: "recipe-scraper" } as AgentState["selectedTool"] } },
          { runTool: { result: { title: "Pancakes" } } },
          { composeResponse: {} },
        ]),
      ),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "scrape https://example.com" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(graph.stream).toHaveBeenCalledWith(
      expect.objectContaining({ request: "scrape https://example.com", authToken: "tok-1" }),
      { streamMode: "updates" },
    );

    const chunks = (await readSse(res)) as { event?: { type?: string; data?: { description?: string } }; choices?: { delta: { content?: string }; finish_reason: string | null }[] }[];
    const statusDescriptions = chunks.filter((c) => c.event?.type === "status").map((c) => c.event?.data?.description ?? "");
    const allContent = chunks.filter((c) => c.choices).map((c) => c.choices![0]?.delta.content ?? "").join("");
    expect(statusDescriptions).toContain("Calling tool: recipe-scraper.");
    expect(allContent).toContain("Pancakes");
    expect(chunks.filter((c) => c.choices).at(-1)?.choices![0]?.finish_reason).toBe("stop");

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) surfaces a mid-graph error as the final assistant message", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi
        .fn()
        .mockResolvedValue(toStream([{ resolveIdentity: { error: "unauthorized: could not resolve caller identity" } }])),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "do a thing" }] }),
    });

    expect(res.status).toBe(200); // headers already sent by the time the graph settles
    const chunks = (await readSse(res)) as { choices: { delta: { content?: string } }[] }[];
    const allContent = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(allContent).toContain("unauthorized");

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) surfaces a planAction 'respond' (no tool call) as the final message instead of hanging until 'agent stream ended unexpectedly'", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(
        toStream([
          { resolveIdentity: { identity: { subject: "alice", roles: ["reader"] } } },
          {
            retrieveSkills: {
              skillCandidates: [
                { skill: { id: "recipe-refining-skill" }, score: 0.9 } as AgentState["skillCandidates"][number],
              ],
            },
          },
          { selectSkill: { selectedSkill: { id: "recipe-refining-skill", name: "Recipe Refining" } as AgentState["selectedSkill"] } },
          { loadSkillTools: { skillTools: [{ id: "recipe-publisher", name: "recipe-publisher" }] as AgentState["skillTools"] } },
          // Planner chose to respond directly (e.g. "publish it!" with no recipe Markdown
          // included) -- no selectedTool, so the graph never reaches runTool.
          { planAction: { result: "I don't see a recipe to publish -- please paste it back in." } },
        ]),
      ),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "publish it!" }] }),
    });

    expect(res.status).toBe(200);
    const chunks = (await readSse(res)) as { type?: string; choices?: { delta: { content?: string }; finish_reason: string | null }[] }[];
    const allContent = chunks.filter((c) => c.choices).map((c) => c.choices![0]?.delta.content ?? "").join("");
    expect(allContent).toContain("please paste it back in");
    expect(allContent).not.toContain("agent stream ended unexpectedly");
    expect(chunks.filter((c) => c.choices).at(-1)?.choices![0]?.finish_reason).toBe("stop");

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) surfaces a selectDelegate best-effort answer (no skill/tool/agent matched) instead of hanging until 'agent stream ended unexpectedly'", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(
        toStream([
          { resolveIdentity: { identity: { subject: "alice", roles: ["reader"] } } },
          { retrieveSkills: { skillCandidates: [] } },
          { retrieveAgents: { agentCandidates: [] } },
          // noMatchFallback's true last resort: no skill/tool/agent selected at
          // all, `result` set directly on selectDelegate -- the graph routes
          // straight to END without ever reaching runTool/composeResponse.
          { selectDelegate: { result: "Here's a peach cocktail syrup recipe...", wasFallback: true } },
        ]),
      ),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "help me create a recipe for peach cocktail syrup" }] }),
    });

    expect(res.status).toBe(200);
    const chunks = (await readSse(res)) as { choices?: { delta: { content?: string }; finish_reason: string | null }[] }[];
    const allContent = chunks.filter((c) => c.choices).map((c) => c.choices![0]?.delta.content ?? "").join("");
    expect(allContent).toContain("peach cocktail syrup recipe");
    expect(allContent).not.toContain("agent stream ended unexpectedly");
    expect(chunks.filter((c) => c.choices).at(-1)?.choices![0]?.finish_reason).toBe("stop");

    await server.close();
  });

  it("POST /v1/chat/completions (streaming) surfaces a bareAnswer (capability-need gate, docs/adr/0019) instead of hanging until 'agent stream ended unexpectedly'", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(
        toStream([
          { resolveIdentity: { identity: { subject: "alice", roles: ["reader"] } } },
          { checkNeedsCapability: { needsCapability: false } },
          // The capability-need gate judged no skill/tool/agent is needed --
          // `result` is set directly on `bareAnswer` and the graph routes
          // straight to END, skipping retrieveSkills/retrieveAgents entirely.
          { bareAnswer: { result: "Paris is the capital of France." } },
        ]),
      ),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "What is the capital of France?" }] }),
    });

    expect(res.status).toBe(200);
    const chunks = (await readSse(res)) as { choices?: { delta: { content?: string }; finish_reason: string | null }[] }[];
    const allContent = chunks.filter((c) => c.choices).map((c) => c.choices![0]?.delta.content ?? "").join("");
    expect(allContent).toContain("Paris is the capital of France");
    expect(allContent).not.toContain("agent stream ended unexpectedly");
    expect(chunks.filter((c) => c.choices).at(-1)?.choices![0]?.finish_reason).toBe("stop");

    await server.close();
  });
});

describe("InvokeServer session-scoped active skill (ADR 0012)", () => {
  const identity = { subject: "open-webui", roles: ["reader"] };
  const selectedSkill = { id: "recipe-skill", name: "Recipe Skill" } as AgentState["selectedSkill"];

  function sessionStore() {
    return new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
  }

  it("remembers the selected skill per chat id and offers it to the graph on the next turn (non-streaming)", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        selectedSkill,
        result: "done",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const send = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok-1",
          "x-openwebui-chat-id": "chat-42",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "extract https://example.com" }] }),
      });

    await send();
    // First turn: no session yet -> plain stateless input.
    expect(graph.invoke).toHaveBeenNthCalledWith(1, {
      request: "extract https://example.com",
      authToken: "tok-1",
      sessionId: "chat-42",
    });

    await send();
    // Second turn: the previous turn's skill + its identity subject are offered.
    expect(graph.invoke).toHaveBeenNthCalledWith(2, {
      request: "extract https://example.com",
      authToken: "tok-1",
      sessionId: "chat-42",
      activeSkillId: "recipe-skill",
      sessionSubject: "open-webui",
    });

    await server.close();
  });

  it("does not persist a session for a failed turn", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        error: "no matching skill for this request",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const send = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-openwebui-chat-id": "chat-42" },
        body: JSON.stringify({ messages: [{ role: "user", content: "do a thing" }] }),
      });

    await send();
    await send();
    expect(graph.invoke).toHaveBeenNthCalledWith(2, { request: "do a thing", authToken: "", sessionId: "chat-42" });

    await server.close();
  });

  it("stays fully stateless when the chat-id header is absent, even with a session store configured", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        selectedSkill,
        result: "done",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const send = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "extract https://example.com" }] }),
      });

    await send();
    await send();
    expect(graph.invoke).toHaveBeenNthCalledWith(2, {
      request: "extract https://example.com",
      authToken: "tok-1",
    });

    await server.close();
  });

  it("persists the session from a streaming turn and narrates continuation on the next one", async () => {
    const streamedTurn = [
      { resolveIdentity: { identity } },
      { retrieveSkills: { skillCandidates: [{ skill: { id: "recipe-skill" }, score: 0.9 }] as AgentState["skillCandidates"] } },
      { selectSkill: { selectedSkill } },
      { loadSkillTools: { skillTools: [{ id: "recipe-scraper", name: "recipe-scraper" }] as AgentState["skillTools"] } },
      { planAction: { result: "extracted!" } },
    ];
    const continuedTurn = [
      { resolveIdentity: { identity } },
      // checkActiveSkill confirmed the session's skill -- retrieval/selection skipped.
      { checkActiveSkill: { selectedSkill } },
      { loadSkillTools: { skillTools: [{ id: "recipe-scraper", name: "recipe-scraper" }] as AgentState["skillTools"] } },
      { planAction: { result: "refined!" } },
    ];
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi
        .fn()
        .mockResolvedValueOnce(toStream(streamedTurn))
        .mockResolvedValueOnce(toStream(continuedTurn)),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const send = (content: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tok-1",
          "x-openwebui-chat-id": "chat-42",
        },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content }] }),
      });

    await (await send("extract https://example.com")).text();
    expect(graph.stream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ request: "extract https://example.com", authToken: "tok-1" }),
      { streamMode: "updates" },
    );

    const res = await send("make it spicier");
    expect(graph.stream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: "make it spicier",
        authToken: "tok-1",
        activeSkillId: "recipe-skill",
        sessionSubject: "open-webui",
      }),
      { streamMode: "updates" },
    );
    const chunks = (await readSse(res)) as { event?: { type?: string; data?: { description?: string } }; choices?: { delta: { content?: string } }[] }[];
    const statusDescriptions = chunks.filter((c) => c.event?.type === "status").map((c) => c.event?.data?.description ?? "");
    const allContent = chunks.filter((c) => c.choices).map((c) => c.choices![0]?.delta.content ?? "").join("");
    expect(statusDescriptions.some((d) => d.startsWith("Continuing with skill: Recipe Skill"))).toBe(true);
    expect(statusDescriptions.every((d) => !d.startsWith("Selected skill"))).toBe(true);

    await server.close();
  });

  it("streams a Remote Control session URL as inline chat content, never a truncated status label", async () => {
    const rcUrl = "https://claude.ai/code/session_abc123";
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      // The delegate node forwards the agent's `remote-control-url` progress
      // event through `progressListener` (agent/graph.ts). The chat facade
      // must render it as real, clickable content -- routing it through a
      // status label (truncated to 120 chars) would mangle the URL.
      stream: vi.fn().mockImplementation((input: { progressListener?: (stage: string, message: string | undefined) => void }) => {
        input.progressListener?.("remote-control-url", rcUrl);
        return toStream([{ planAction: { identity, result: "Opened PR #42." } }]);
      }),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        "x-openwebui-chat-id": "chat-rc",
      },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "fix the bug" }] }),
    });

    const chunks = (await readSse(res)) as {
      event?: { type?: string; data?: { description?: string } };
      choices?: { delta: { content?: string } }[];
    }[];
    const allContent = chunks
      .filter((c) => c.choices)
      .map((c) => c.choices![0]?.delta.content ?? "")
      .join("");
    const statusDescriptions = chunks
      .filter((c) => c.event?.type === "status")
      .map((c) => c.event?.data?.description ?? "");

    // The full URL is delivered as content with a "watch live" affordance...
    expect(allContent).toContain(rcUrl);
    expect(allContent).toContain("Watch live or take over");
    // ...the actual turn result still follows...
    expect(allContent).toContain("Opened PR #42.");
    // ...and the URL never leaks into a (truncated) status label.
    expect(statusDescriptions.every((d) => !d.includes("claude.ai/code"))).toBe(true);

    await server.close();
  });

  it("accepts an optional session_id on POST /invoke for non-chat callers", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity,
        selectedSkill,
        result: "done",
      } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph, sessionStore());
    const port = await listenOn(server);

    const send = () =>
      fetch(`http://127.0.0.1:${port}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
        body: JSON.stringify({ request: "extract https://example.com", session_id: "cli-7" }),
      });

    await send();
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget graph run persists async
    await send();
    expect(graph.invoke).toHaveBeenNthCalledWith(2, {
      request: "extract https://example.com",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
      sessionId: "cli-7",
      activeSkillId: "recipe-skill",
      sessionSubject: "open-webui",
    });

    await server.close();
  });

  it("threads an explicit identity_link_flow on POST /invoke into the graph input", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "tok-1", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR", identity_link_flow: "device" }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith({
      request: "open a PR",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      identityLinkFlow: "device",
      reportIdentityLinkPending: expect.any(Function),
    });

    await server.close();
  });

  it("silently ignores a missing or invalid identity_link_flow on POST /invoke, without failing the request", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "tok-1", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const omittedRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR" }),
    });
    expect(omittedRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(graph.invoke).toHaveBeenLastCalledWith({
      request: "open a PR",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
    });

    const invalidRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR", identity_link_flow: "carrier-pigeon" }),
    });
    expect(invalidRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(graph.invoke).toHaveBeenLastCalledWith({
      request: "open a PR",
      authToken: "tok-1",
      remoteControlUrlListener: expect.any(Function),
      reportIdentityLinkPending: expect.any(Function),
    });

    await server.close();
  });
});

describe("InvokeServer live-session tunnel (ADR 0026)", () => {
  const graph: AgentGraphLike = {
    invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "", skillCandidates: [] } as unknown as AgentState),
    stream: vi.fn().mockResolvedValue(noStream()),
  };

  function fakeChannel(overrides: Partial<AgentOrchestratorChannel> = {}): AgentOrchestratorChannel {
    return {
      awaitReply: vi.fn(),
      sendPrompt: vi.fn(),
      close: vi.fn(),
      ...overrides,
    };
  }

  it("404s on all three routes when no agentChannel is configured", async () => {
    const server = new InvokeServer(graph, new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 }));
    const port = await listenOn(server);

    expect((await fetch(`http://127.0.0.1:${port}/sessions/live?sessionId=s1`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/agent-runs/run-1/events?sessionId=s1`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/agent-runs/run-1/opencode?sessionId=s1`, { method: "POST" })).status,
    ).toBe(404);

    await server.close();
  });

  it("reports not live when the session has no lastAgentRunId", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    const forwardOpencodeRequest = vi.fn();
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ forwardOpencodeRequest }));
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/sessions/live?sessionId=unknown-session`, {
      headers: { authorization: "Bearer tok-1" },
    });
    expect(await res.json()).toEqual({ live: false });
    expect(forwardOpencodeRequest).not.toHaveBeenCalled();

    await server.close();
  });

  it("reports live via a real-time health probe when the session has a lastAgentRunId that responds", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    await sessionStore.set("acme-session", { subject: "alice", lastAgentRunId: "run-42" });
    const forwardOpencodeRequest = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ forwardOpencodeRequest }));
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/sessions/live?sessionId=acme-session`, {
      headers: { authorization: "Bearer tok-1" },
    });
    expect(await res.json()).toEqual({ live: true, agentRunId: "run-42" });
    expect(forwardOpencodeRequest).toHaveBeenCalledWith("run-42", { method: "GET", path: "/global/health" }, 2_000);

    await server.close();
  });

  it("reports not live when the probe times out (Pod no longer reachable)", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    await sessionStore.set("acme-session", { subject: "alice", lastAgentRunId: "run-42" });
    const forwardOpencodeRequest = vi.fn().mockRejectedValue(new Error("timed out"));
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ forwardOpencodeRequest }));
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/sessions/live?sessionId=acme-session`, {
      headers: { authorization: "Bearer tok-1" },
    });
    expect(await res.json()).toEqual({ live: false });

    await server.close();
  });

  it("401s the live routes without a bearer token", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ forwardOpencodeRequest: vi.fn() }));
    const port = await listenOn(server);

    expect((await fetch(`http://127.0.0.1:${port}/sessions/live?sessionId=s1`)).status).toBe(401);

    await server.close();
  });

  it("forwards a proxied opencode request only when the session's own lastAgentRunId matches the runId in the URL", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    await sessionStore.set("acme-session", { subject: "alice", lastAgentRunId: "run-42" });
    const forwardOpencodeRequest = vi.fn().mockResolvedValue({ status: 200, body: { finalMessage: "hi" } });
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ forwardOpencodeRequest }));
    const port = await listenOn(server);

    const wrongRunRes = await fetch(`http://127.0.0.1:${port}/agent-runs/some-other-run/opencode?sessionId=acme-session`, {
      method: "POST",
      headers: { authorization: "Bearer tok-1", "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/session/ses_1/message", body: { parts: [] } }),
    });
    expect(wrongRunRes.status).toBe(404);
    expect(forwardOpencodeRequest).not.toHaveBeenCalled();

    const res = await fetch(`http://127.0.0.1:${port}/agent-runs/run-42/opencode?sessionId=acme-session`, {
      method: "POST",
      headers: { authorization: "Bearer tok-1", "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "/session/ses_1/message", body: { parts: [{ type: "text", text: "hi" }] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 200, body: { finalMessage: "hi" } });
    expect(forwardOpencodeRequest).toHaveBeenCalledWith("run-42", {
      method: "POST",
      path: "/session/ses_1/message",
      body: { parts: [{ type: "text", text: "hi" }] },
    });

    await server.close();
  });

  it("streams opencode_event up-messages as SSE and closes on session_ended", async () => {
    const sessionStore = new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
    await sessionStore.set("acme-session", { subject: "alice", lastAgentRunId: "run-42" });
    let deliver!: (msg: { type: string; [k: string]: unknown }) => void;
    const subscribeLive = vi.fn((_runId: string, onMessage: (msg: never) => void) => {
      deliver = onMessage as unknown as typeof deliver;
      return { unsubscribe: vi.fn() };
    });
    const server = new InvokeServer(graph, sessionStore, undefined, undefined, fakeChannel({ subscribeLive: subscribeLive as unknown as AgentOrchestratorChannel["subscribeLive"] }));
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/agent-runs/run-42/events?sessionId=acme-session`, {
      headers: { authorization: "Bearer tok-1" },
    });
    expect(res.status).toBe(200);
    expect(subscribeLive).toHaveBeenCalledWith("run-42", expect.any(Function));

    deliver({ type: "opencode_event", event: { type: "message.part.updated", part: { text: "hi" } } });
    deliver({ type: "session_ended", reason: "idle timeout" });

    const body = await res.text();
    expect(body).toContain('data: {"type":"message.part.updated","part":{"text":"hi"}}');
    expect(body).toContain("event: session_ended");

    await server.close();
  });
});

describe("InvokeServer canonical credential subject plumbing", () => {
  it("threads event.senderLogin from POST /invoke into the graph input", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "tok-1", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        request: "triage this issue",
        event: { source: "github", event: "issues", action: "labeled", senderLogin: "imaustink" },
      }),
    });
    await new Promise((r) => setTimeout(r, 10));

    // No IntegrationRoute registry is configured on this server, and the
    // login must STILL come through -- cross-flow credential sharing can't
    // be made to depend on routing config.
    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({ senderLogin: "imaustink" }));

    await server.close();
  });

  it("reports the pending link's OWN subject on GET /invoke/:id, not the raw identity subject", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity: { subject: "service-subject", roles: ["reader"] },
        pendingIdentityLink: {
          agentId: "claude-code-swe",
          provider: "claude-remote",
          flow: "page",
          expiresAt: Date.now() + 600_000,
          subject: "github:imaustink",
        },
        identityLinkPending: true,
        result: "please link your Claude account",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "triage this issue" }),
    });
    const { id } = (await postRes.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 10));

    const done = (await (await fetch(`http://127.0.0.1:${port}/invoke/${id}`)).json()) as {
      identityLink?: { provider: string; subject: string };
    };
    // integration-gateway's waitAndResume blocks on exactly this subject. If
    // it were recomputed from identity.subject it would wait on a record the
    // link never writes -- the PR #144 re-auth loop.
    expect(done.identityLink).toEqual({ provider: "claude-remote", subject: "github:imaustink" });

    await server.close();
  });

  it("falls back to the identity subject for a link parked before the subject field existed", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        request: "x",
        authToken: "tok-1",
        skillCandidates: [],
        identity: { subject: "alice", roles: ["reader"] },
        pendingIdentityLink: {
          agentId: "opencode-swe",
          provider: "github",
          flow: "authcode",
          expiresAt: Date.now() + 600_000,
        },
        identityLinkPending: true,
        result: "please link your GitHub account",
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR" }),
    });
    const { id } = (await postRes.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 10));

    const done = (await (await fetch(`http://127.0.0.1:${port}/invoke/${id}`)).json()) as {
      identityLink?: { provider: string; subject: string };
    };
    expect(done.identityLink).toEqual({ provider: "github", subject: "alice" });

    await server.close();
  });
});

describe("InvokeServer signed sender assertion (docs/adr/0030 §6)", () => {
  const SECRET = "assertion-secret";

  function serverWithAssertions(graph: AgentGraphLike) {
    // Positional order: graph, sessionStore, taskCompleter,
    // integrationRouteRegistry, agentChannel, senderAssertionSecret.
    return new InvokeServer(graph, undefined, undefined, undefined, undefined, SECRET);
  }

  function graphSpy(): AgentGraphLike {
    return {
      invoke: vi.fn().mockResolvedValue({ request: "x", authToken: "t", skillCandidates: [], result: "done" } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
  }

  it("accepts a login only from a verified assertion, ignoring the unsigned body field", async () => {
    const graph = graphSpy();
    const server = serverWithAssertions(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok-1",
        [SENDER_ASSERTION_HEADER]: mintSenderAssertion(SECRET, "imaustink"),
      },
      // A DIFFERENT login in the body: with a secret configured this must be
      // ignored outright, not merged or preferred.
      body: JSON.stringify({ request: "triage", event: { source: "github", senderLogin: "victim" } }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({ senderLogin: "imaustink" }));
    await server.close();
  });

  it("drops an unsigned senderLogin entirely when a secret is configured", async () => {
    const graph = graphSpy();
    const server = serverWithAssertions(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "triage", event: { source: "github", senderLogin: "victim" } }),
    });
    await new Promise((r) => setTimeout(r, 10));

    // No principal rather than the WRONG principal: holding the gateway's
    // token must not be enough to be handed another person's credentials.
    const arg = (graph.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { senderLogin?: string };
    expect(arg.senderLogin).toBeUndefined();
    await server.close();
  });

  it("still trusts the body field when no secret is configured (upgrade compatibility)", async () => {
    const graph = graphSpy();
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "triage", event: { source: "github", senderLogin: "imaustink" } }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({ senderLogin: "imaustink" }));
    await server.close();
  });
});

describe("InvokeServer consumer-supplied tools (docs/adr/0035)", () => {
  /** A valid OpenAI `tools[]` entry. */
  function toolDef(name: string, description = "does a thing") {
    return {
      type: "function",
      function: { name, description, parameters: { type: "object", properties: { q: { type: "string" } } } },
    };
  }

  it("resolves the caller's tools onto the graph input", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ result: "ok" } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "what's the weather?" }],
        tools: [toolDef("get_weather", "Look up the weather")],
      }),
    });

    expect(graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        callerTools: [
          expect.objectContaining({
            id: "caller:get_weather",
            name: "get_weather",
            allowedRoles: [],
            callerTool: expect.objectContaining({ name: "get_weather" }),
          }),
        ],
      }),
    );
    await server.close();
  });

  it("leaves the graph input untouched when the caller sends no tools", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ result: "ok" } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(graph.invoke).toHaveBeenCalledWith({ request: "hi", authToken: "tok-1" });
    await server.close();
  });

  it("400s a malformed tools array instead of silently ignoring it", async () => {
    // A client that offers tools and silently never gets a tool call can't tell
    // "not chosen" from "never seen".
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "bad name!" } }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("must match");
    expect(graph.invoke).not.toHaveBeenCalled();
    await server.close();
  });

  it("(non-streaming) returns tool_calls with finish_reason tool_calls", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        pendingToolCalls: [{ id: "call_abc", name: "get_weather", arguments: '{"city":"Chicago"}' }],
      } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "weather?" }],
        tools: [toolDef("get_weather")],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: unknown; tool_calls: { function: { name: string } }[] }; finish_reason: string }[];
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    expect(body.choices[0]!.message.content).toBeNull();
    expect(body.choices[0]!.message.tool_calls[0]!.function.name).toBe("get_weather");
    await server.close();
  });

  it("(streaming) emits a tool_calls delta then a tool_calls finish", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(
        toStream([
          { resolveIdentity: { identity: { subject: "alice", roles: ["reader"] } } },
          { runTool: { pendingToolCalls: [{ id: "call_abc", name: "get_weather", arguments: '{"city":"Chicago"}' }] } },
        ]),
      ),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "weather?" }],
        tools: [toolDef("get_weather")],
      }),
    });

    const chunks = (await readSse(res)) as {
      choices?: { delta: { tool_calls?: { index: number; function: { name: string } }[] }; finish_reason: string | null }[];
    }[];
    const withChoices = chunks.filter((c) => c.choices);
    expect(withChoices[0]!.choices![0]!.delta.tool_calls).toEqual([
      { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Chicago"}' } },
    ]);
    expect(withChoices.at(-1)!.choices![0]!.finish_reason).toBe("tool_calls");
    await server.close();
  });

  it("passes a client-executed tool result back as seeded actionHistory", async () => {
    // The full round trip: the client ran our tool call and resent the
    // conversation with the result (docs/adr/0035 §1).
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ result: "It's 58F and raining." } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "weather in Chicago?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Chicago"}' } }],
          },
          { role: "tool", tool_call_id: "call_abc", content: "58F and raining" },
        ],
        tools: [toolDef("get_weather")],
      }),
    });

    expect(graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "weather in Chicago?",
        actionHistory: [
          { toolId: "caller:get_weather", toolArgs: '{"city":"Chicago"}', result: "58F and raining" },
        ],
      }),
    );
    await server.close();
  });

  it("never reaches the graph — or emits a tool call — for an Open WebUI housekeeping request", async () => {
    // Open WebUI sends title/tag generation to the SAME endpoint with the same
    // body, tool array included. Emitting a tool call here would have the client
    // execute a real function as a side effect of rendering a chat title
    // (docs/adr/0035 §5).
    const graph: AgentGraphLike = { invoke: vi.fn(), stream: vi.fn() };
    const server = new InvokeServer(graph, undefined, {
      complete: vi.fn().mockResolvedValue("Chicago Weather"),
    } as unknown as ConstructorParameters<typeof InvokeServer>[2]);
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "### Task:\nGenerate a concise title" }],
        tools: [toolDef("get_weather")],
      }),
    });

    expect(graph.invoke).not.toHaveBeenCalled();
    const body = (await res.json()) as { choices: { message: { content: string }; finish_reason: string }[] };
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(body.choices[0]!.message.content).toBe("Chicago Weather");
    await server.close();
  });

  it("consults the caller-tool store only above the top-K threshold", async () => {
    // Below it there is nothing to prune, so the JIT index must not be touched
    // at all (docs/adr/0035 §3).
    const callerToolStore = {
      index: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockImplementation((_t: string, tools: unknown[], k: number) => Promise.resolve(tools.slice(0, k))),
      prune: vi.fn(),
    };
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({ result: "ok" } as AgentState),
      stream: vi.fn(),
    };
    const server = new InvokeServer(graph, undefined, undefined, undefined, undefined, undefined, callerToolStore, 2);
    const port = await listenOn(server);

    const post = (tools: unknown[]): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools }),
      });

    await post([toolDef("a"), toolDef("b")]);
    expect(callerToolStore.index).not.toHaveBeenCalled();

    await post([toolDef("a"), toolDef("b"), toolDef("c")]);
    expect(callerToolStore.index).toHaveBeenCalledTimes(1);
    expect(callerToolStore.search).toHaveBeenCalledWith("hi", expect.arrayContaining([expect.anything()]), 2);
    // Pruned to top-K before it ever reaches the planner.
    const lastCall = (graph.invoke as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { callerTools: unknown[] };
    expect(lastCall.callerTools).toHaveLength(2);

    await server.close();
  });

  it("surfaces pendingToolCalls on GET /invoke/:id for a programmatic caller", async () => {
    const graph: AgentGraphLike = {
      invoke: vi.fn().mockResolvedValue({
        pendingToolCalls: [{ id: "call_abc", name: "get_weather", arguments: "{}" }],
      } as AgentState),
      stream: vi.fn().mockResolvedValue(noStream()),
    };
    const server = new InvokeServer(graph);
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "weather?", tools: [toolDef("get_weather")] }),
    });
    const { id } = (await postRes.json()) as { id: string };
    await vi.waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/invoke/${id}`);
      const body = (await res.json()) as { status: string; pendingToolCalls?: { name: string }[] };
      expect(body.status).toBe("succeeded");
      expect(body.pendingToolCalls?.[0]?.name).toBe("get_weather");
    });

    await server.close();
  });
});
