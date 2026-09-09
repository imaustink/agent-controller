import { describe, expect, it, vi } from "vitest";
import { runCommand } from "./execute.js";
import { GlyphClient } from "./glyph/client.js";
import { parseCommand } from "./commands.js";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Builds a fetch stub that dispatches on `${METHOD} ${pathname}`. */
function router(routes: Record<string, (init: RequestInit) => Response>): typeof fetch {
  return vi.fn((url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return Promise.resolve(handler(init));
  }) as unknown as typeof fetch;
}

function clientWith(routes: Record<string, (init: RequestInit) => Response>): GlyphClient {
  return new GlyphClient({ baseUrl: "https://glyph.example.com", token: "t", fetchTimeoutMs: 5000 }, router(routes));
}

const run = (raw: string, client: GlyphClient) => runCommand(client, parseCommand(raw));

describe("runCommand — notes", () => {
  it("creates a note and writes its body content", async () => {
    let contentBody: unknown;
    const client = clientWith({
      "POST /api/v1/pages": () => json({ id: NOTE_ID, title: "Plan", type: "page", tags: [], priority: "none" }),
      [`PUT /api/v1/pages/${NOTE_ID}/content`]: (init) => {
        contentBody = JSON.parse(init.body as string);
        return json({ pageId: NOTE_ID, content: null });
      },
    });

    const out = await run(JSON.stringify({ resource: "note", action: "create", title: "Plan", body: "# Plan" }), client);

    expect(out).toContain("Created note **Plan**");
    expect(out).toContain(NOTE_ID);
    expect(contentBody).toMatchObject({ content: { type: "doc" } });
  });

  it("does not write content when no body is given", async () => {
    const put = vi.fn();
    const client = clientWith({
      "POST /api/v1/pages": () => json({ id: NOTE_ID, title: "Plan", type: "page", tags: [], priority: "none" }),
      [`PUT /api/v1/pages/${NOTE_ID}/content`]: () => {
        put();
        return json({});
      },
    });

    await run(JSON.stringify({ resource: "note", action: "create", title: "Plan" }), client);
    expect(put).not.toHaveBeenCalled();
  });

  it("reads a note and renders its content as markdown", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] };
    const client = clientWith({
      [`GET /api/v1/pages/${NOTE_ID}`]: () => json({ id: NOTE_ID, title: "Plan", type: "page", tags: ["a"], priority: "high" }),
      [`GET /api/v1/pages/${NOTE_ID}/content`]: () => json({ pageId: NOTE_ID, content: doc }),
    });

    const out = await run(JSON.stringify({ resource: "note", action: "get", id: NOTE_ID }), client);
    expect(out).toContain("# Plan");
    expect(out).toContain("hello");
  });

  it("treats a missing content document as an empty body", async () => {
    const client = clientWith({
      [`GET /api/v1/pages/${NOTE_ID}`]: () => json({ id: NOTE_ID, title: "Empty", type: "page", tags: [], priority: "none" }),
      [`GET /api/v1/pages/${NOTE_ID}/content`]: () => json({ error: "not found" }, 404),
    });

    const out = await run(JSON.stringify({ resource: "note", action: "get", id: NOTE_ID }), client);
    expect(out).toContain("_(empty note)_");
  });

  it("searches notes by title and excludes folders", async () => {
    const client = clientWith({
      "GET /api/v1/pages": () =>
        json([
          { id: NOTE_ID, title: "Roadmap", type: "page", tags: [], priority: "none" },
          { id: "33333333-3333-4333-8333-333333333333", title: "Roadmap folder", type: "folder", tags: [], priority: "none" },
          { id: "44444444-4444-4444-8444-444444444444", title: "Groceries", type: "page", tags: [], priority: "none" },
        ]),
    });

    const out = await run(JSON.stringify({ resource: "note", action: "search", query: "road" }), client);
    expect(out).toContain("Roadmap");
    expect(out).not.toContain("folder");
    expect(out).not.toContain("Groceries");
  });
});

describe("runCommand — tasks", () => {
  it("creates a task", async () => {
    const client = clientWith({
      "POST /api/v1/tasks": () => json({ id: TASK_ID, title: "Ship", status: "todo", priority: "high", tags: [], dueDate: null }),
    });
    const out = await run(JSON.stringify({ resource: "task", action: "create", title: "Ship", priority: "high" }), client);
    expect(out).toContain("Created task **Ship**");
    expect(out).toContain("high priority");
  });

  it("searches tasks with status/priority/text filters", async () => {
    const client = clientWith({
      "GET /api/v1/tasks": () =>
        json([
          { id: TASK_ID, title: "Ship the PR", description: "", status: "todo", priority: "high", tags: [], dueDate: null },
          { id: "55555555-5555-4555-8555-555555555555", title: "Ship docs", description: "", status: "done", priority: "high", tags: [], dueDate: null },
          { id: "66666666-6666-4666-8666-666666666666", title: "Buy milk", description: "", status: "todo", priority: "low", tags: [], dueDate: null },
        ]),
    });

    const out = await run(JSON.stringify({ resource: "task", action: "search", query: "ship", status: "todo" }), client);
    expect(out).toContain("Ship the PR");
    expect(out).not.toContain("Ship docs"); // filtered out by status
    expect(out).not.toContain("Buy milk"); // filtered out by query
  });

  it("reports no matches distinctly from no tasks", async () => {
    const client = clientWith({ "GET /api/v1/tasks": () => json([]) });
    const out = await run(JSON.stringify({ resource: "task", action: "search", query: "zzz" }), client);
    expect(out).toContain('No tasks matched "zzz"');
  });

  it("updates a task", async () => {
    let patch: unknown;
    const client = clientWith({
      [`PATCH /api/v1/tasks/${TASK_ID}`]: (init) => {
        patch = JSON.parse(init.body as string);
        return json({ id: TASK_ID, title: "Ship", status: "done", priority: "high", tags: [], dueDate: null });
      },
    });

    const out = await run(JSON.stringify({ resource: "task", action: "update", id: TASK_ID, status: "done" }), client);
    expect(patch).toEqual({ status: "done" });
    expect(out).toContain("Updated task **Ship**");
    expect(out).toContain("done");
  });
});
