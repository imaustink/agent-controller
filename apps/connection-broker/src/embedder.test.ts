import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbedder } from "./embedder.js";

const respond = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe("OpenAIEmbedder", () => {
  it("embeds a whole batch in one request", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }),
    );
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    expect(await embedder.embed(["a", "b"])).toEqual([[1], [2]]);
    // One request per chunk would turn a page of 20 chunks into 20 round trips.
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("orders vectors by index rather than trusting arrival order", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
    );
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    // The writer zips vectors to chunks positionally, so a reordering would
    // pair every chunk with another chunk's embedding — wrong in every
    // retrieval, erroring nowhere.
    expect(await embedder.embed(["a", "b"])).toEqual([[1], [2]]);
  });

  it("refuses a response with the wrong number of vectors", async () => {
    const http = vi.fn().mockResolvedValue(respond({ data: [{ index: 0, embedding: [1] }] }));
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("does not call out at all for an empty batch", async () => {
    const http = vi.fn();
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    expect(await embedder.embed([])).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it("carries the provider's explanation into the error", async () => {
    const http = vi.fn().mockResolvedValue(respond({ error: "model not found" }, false, 404));
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    await expect(embedder.embed(["a"])).rejects.toThrow(/model not found/);
  });
});
