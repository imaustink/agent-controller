import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbedder, batchInputs } from "./embedder.js";

const respond = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

/** A mock endpoint that answers each request with one vector per input it received. */
function embeddingServer(perInput: (text: string, index: number) => number[] = (_t, i) => [i]) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const inputs = (JSON.parse(init.body) as { input: string[] }).input;
    return respond({ data: inputs.map((text, i) => ({ index: i, embedding: perInput(text, i) })) });
  });
}

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

  it("splits a corpus that exceeds the per-request token cap into multiple calls", async () => {
    // Two inputs ~150k estimated tokens each: together over the 250k budget, so
    // they must go in separate requests rather than one 300k+ call that 400s.
    const big = "x".repeat(450_000);
    const http = embeddingServer((_t, i) => [i]);
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    const vectors = await embedder.embed([big, big]);

    expect(http).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(2);
  });

  it("preserves overall order across batches", async () => {
    // Force three single-input batches by the input-count path and check the
    // concatenation stays in input order.
    const http = embeddingServer((text) => [text.charCodeAt(0)]);
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    const over = "y".repeat(260_000); // each alone ~86k tokens; 3 of them need 2+ batches
    const vectors = await embedder.embed([`a${over}`, `b${over}`, `c${over}`]);

    expect(vectors).toEqual([["a".charCodeAt(0)], ["b".charCodeAt(0)], ["c".charCodeAt(0)]].map(([c]) => [c]));
  });

  it("splits and retries a batch the provider still rejects with a 400", async () => {
    // The estimate only has to be roughly right: a batch that still 400s is
    // halved until it succeeds (or a single input surfaces the real error).
    const http = vi.fn(async (_url: string, init: { body: string }) => {
      const inputs = (JSON.parse(init.body) as { input: string[] }).input;
      if (inputs.length > 1) return respond({ error: "max tokens per request" }, false, 400);
      return respond({ data: [{ index: 0, embedding: [inputs[0] === "a" ? 1 : 2] }] });
    });
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    expect(await embedder.embed(["a", "b"])).toEqual([[1], [2]]);
    // One rejected 2-input call, then two successful 1-input retries.
    expect(http).toHaveBeenCalledTimes(3);
  });

  it("gives up on a persistent 400 for a single input instead of looping", async () => {
    const http = vi.fn().mockResolvedValue(respond({ error: "input too long" }, false, 400));
    const embedder = new OpenAIEmbedder({ apiKey: "k", fetchImpl: http as unknown as typeof fetch });

    await expect(embedder.embed(["a"])).rejects.toThrow(/input too long/);
  });
});

describe("batchInputs", () => {
  it("keeps a small set in one batch", () => {
    expect(batchInputs(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("caps a batch at 2048 inputs", () => {
    const many = Array.from({ length: 2049 }, () => "x");
    const batches = batchInputs(many);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2048);
    expect(batches[1]).toHaveLength(1);
  });

  it("starts a new batch before the token budget is exceeded", () => {
    const big = "x".repeat(450_000); // ~150k est. tokens; two exceed the 250k budget
    expect(batchInputs([big, big])).toEqual([[big], [big]]);
  });
});
