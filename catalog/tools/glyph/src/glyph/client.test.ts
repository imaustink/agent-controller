import { describe, expect, it, vi } from "vitest";
import { GlyphApiError, GlyphClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CFG = { baseUrl: "https://glyph.example.com", token: "tok-abc", fetchTimeoutMs: 5000 };

describe("GlyphClient", () => {
  it("targets /api/v1 with a Bearer token and JSON headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "p1", title: "N", type: "page", tags: [] }));
    const client = new GlyphClient(CFG, fetchImpl as unknown as typeof fetch);

    await client.createPage({ title: "N" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://glyph.example.com/api/v1/pages");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok-abc");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ type: "page", title: "N", tags: [] });
  });

  it("sends page content under a `content` key on PUT", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pageId: "p1", content: null }));
    const client = new GlyphClient(CFG, fetchImpl as unknown as typeof fetch);

    await client.upsertPageContent("p1", { type: "doc", content: [] });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://glyph.example.com/api/v1/pages/p1/content");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ content: { type: "doc", content: [] } });
  });

  it("surfaces the API error message and status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "insufficient scope" }, 403));
    const client = new GlyphClient(CFG, fetchImpl as unknown as typeof fetch);

    await expect(client.listTasks()).rejects.toMatchObject({
      status: 403,
    });
    await expect(client.listTasks()).rejects.toBeInstanceOf(GlyphApiError);
  });

  it("wraps a network failure as a status-0 GlyphApiError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new GlyphClient(CFG, fetchImpl as unknown as typeof fetch);

    await expect(client.getTask("t1")).rejects.toMatchObject({ status: 0 });
  });

  it("only sends provided task patch fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "t1", title: "T", status: "done" }));
    const client = new GlyphClient(CFG, fetchImpl as unknown as typeof fetch);

    await client.updateTask("t1", { status: "done" });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });
});
