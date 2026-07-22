import { describe, expect, it, vi } from "vitest";
import { InvokeServer, type AgentGraphLike } from "./server.js";
import type { AgentState } from "./agent/graph.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";

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
    expect(graph.invoke).toHaveBeenCalledWith({ request: "scrape https://example.com/recipe", authToken: "tok-1" });

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
    expect(graph.invoke).toHaveBeenCalledWith({ request: "do a thing", authToken: "" });

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
});

describe("InvokeServer session-scoped pending identity link (GitHub OAuth Device Flow)", () => {
  function sessionStore() {
    return new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
  }

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
      identityLinkFlow: "device",
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
    expect(graph.invoke).toHaveBeenLastCalledWith({ request: "open a PR", authToken: "tok-1" });

    const invalidRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
      body: JSON.stringify({ request: "open a PR", identity_link_flow: "carrier-pigeon" }),
    });
    expect(invalidRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(graph.invoke).toHaveBeenLastCalledWith({ request: "open a PR", authToken: "tok-1" });

    await server.close();
  });
});
