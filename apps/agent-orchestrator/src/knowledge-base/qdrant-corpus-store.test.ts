import { describe, expect, it, vi } from "vitest";
import { QdrantCorpusStore } from "./qdrant-corpus-store.js";

const embedder = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };

const chunk = (overrides: Record<string, unknown> = {}) => ({
  connectionId: "snc-confluence",
  sourceId: "12345",
  sourceUrl: "https://wiki/page",
  contentHash: "h1",
  text: "body",
  ...overrides,
});

function respond(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function store(fetchImpl: typeof fetch) {
  return new QdrantCorpusStore({ url: "http://q", collection: "corpus-a", fetchImpl }, embedder);
}

describe("query", () => {
  it("decodes the descriptor the broker wrote", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, {
        result: [{ score: 0.8, payload: { id: "h1", descriptor: JSON.stringify(chunk()) } }],
      }),
    );

    const hits = await store(http as unknown as typeof fetch).query("q", { callerRoles: ["reader"] }, 5);

    // The payload shape is fixed by a writer that must also satisfy a Go
    // reader: descriptor is a JSON STRING, not an object.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunk.sourceUrl).toBe("https://wiki/page");
    expect(hits[0]!.score).toBe(0.8);
  });

  it("fails closed for a caller with no roles", async () => {
    const http = vi.fn();
    // An unresolved identity must not run an unfiltered search over client
    // material (ADR 0004).
    expect(await store(http as unknown as typeof fetch).query("q", { callerRoles: [] }, 5)).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it("filters on roles and excludes hidden points", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { result: [] }));
    await store(http as unknown as typeof fetch).query("q", { callerRoles: ["reader"] }, 5);

    const body = JSON.parse((http.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.filter.should).toContainEqual({ key: "roles", match: { any: ["reader"] } });
    expect(body.filter.must_not).toContainEqual({ key: "hidden", match: { value: true } });
  });

  it("treats a missing collection as an empty corpus", async () => {
    const http = vi.fn().mockResolvedValue(respond(404, { status: { error: "doesn't exist" } }));

    // The state of a Connection that has not synced yet. Throwing would take
    // down the whole fan-out and its healthy siblings with it.
    expect(await store(http as unknown as typeof fetch).query("q", { callerRoles: ["r"] }, 5)).toEqual([]);
  });

  it("raises anything else, rather than reporting an empty corpus", async () => {
    const http = vi.fn().mockResolvedValue(respond(500, { error: "boom" }));
    // "Nothing found" and "could not look" must not be the same answer.
    await expect(
      store(http as unknown as typeof fetch).query("q", { callerRoles: ["r"] }, 5),
    ).rejects.toThrow(/qdrant search/);
  });

  it("skips a point whose provenance cannot be decoded", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, {
        result: [
          { score: 0.9, payload: { descriptor: "not json" } },
          { score: 0.8, payload: { descriptor: JSON.stringify({ text: "no url" }) } },
          { score: 0.7, payload: { descriptor: JSON.stringify(chunk()) } },
        ],
      }),
    );

    // A chunk without provenance cannot be cited, and an uncited claim about a
    // client's material is not an acceptable answer.
    const hits = await store(http as unknown as typeof fetch).query("q", { callerRoles: ["r"] }, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunk.contentHash).toBe("h1");
  });
});
