import type { QdrantClient } from "@qdrant/js-client-rest";
import { describe, expect, it, vi } from "vitest";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import { makeCallerTool } from "./parse.js";
import { QdrantCallerToolStore } from "./qdrant-caller-tool-store.js";

const CONFIG = { url: "http://q", collection: "caller_tools", vectorSize: 3 };

function fakeEmbedder(vector = [1, 2, 3]): Embedder & { embed: ReturnType<typeof vi.fn> } {
  return { embed: vi.fn().mockResolvedValue(vector) };
}

const weather = makeCallerTool("get_weather", "Look up the weather", { type: "object" });
const calendar = makeCallerTool("list_events", "List calendar events", { type: "object" });

/** A point as Qdrant would return it for an already-indexed definition. */
function pointFor(tool: { hash: string; name: string; description: string; parametersJson: string }, lastSeenAt = 1_000) {
  return { id: toQdrantPointId(tool.hash), payload: { ...tool, lastSeenAt } };
}

describe("QdrantCallerToolStore", () => {
  describe("index (the embedding cache)", () => {
    it("embeds and upserts only definitions Qdrant doesn't already have", async () => {
      // The whole point of content-hash keying (docs/adr/0035 §2): a client
      // resends the same tool array every turn, so the steady state must cost
      // zero embeddings.
      const client = {
        retrieve: vi.fn().mockResolvedValue([pointFor(weather)]),
        upsert: vi.fn().mockResolvedValue(true),
        setPayload: vi.fn().mockResolvedValue(true),
      } as unknown as QdrantClient;
      const embedder = fakeEmbedder();
      const store = new QdrantCallerToolStore(CONFIG, embedder, client, () => 5_000);

      await store.index([weather, calendar]);

      // Only the miss was embedded.
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      expect(embedder.embed).toHaveBeenCalledWith("list_events: List calendar events");
      expect(client.upsert).toHaveBeenCalledWith("caller_tools", {
        points: [
          {
            id: toQdrantPointId(calendar.hash),
            vector: [1, 2, 3],
            payload: {
              hash: calendar.hash,
              name: "list_events",
              description: "List calendar events",
              parametersJson: calendar.parametersJson,
              lastSeenAt: 5_000,
            },
          },
        ],
        wait: true,
      });
    });

    it("refreshes lastSeenAt on cache hits without re-embedding them", async () => {
      // Keeps an actively-used definition from ageing out from under a live
      // conversation, at the cost of a payload-only write.
      const client = {
        retrieve: vi.fn().mockResolvedValue([pointFor(weather)]),
        upsert: vi.fn().mockResolvedValue(true),
        setPayload: vi.fn().mockResolvedValue(true),
      } as unknown as QdrantClient;
      const embedder = fakeEmbedder();
      const store = new QdrantCallerToolStore(CONFIG, embedder, client, () => 9_000);

      await store.index([weather]);

      expect(embedder.embed).not.toHaveBeenCalled();
      expect(client.upsert).not.toHaveBeenCalled();
      expect(client.setPayload).toHaveBeenCalledWith("caller_tools", {
        payload: { lastSeenAt: 9_000 },
        points: [toQdrantPointId(weather.hash)],
        wait: false,
      });
    });

    it("is a no-op for an empty tool list", async () => {
      const client = { retrieve: vi.fn(), upsert: vi.fn(), setPayload: vi.fn() } as unknown as QdrantClient;
      await new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client).index([]);
      expect(client.retrieve).not.toHaveBeenCalled();
      expect(client.upsert).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("restricts the search to the ids this request supplied", async () => {
      // The id allowlist IS the isolation boundary (docs/adr/0035 §2) -- the
      // collection is a shared namespace with no RBAC payload filter, so this
      // filter is what makes cross-caller leakage impossible.
      const client = {
        search: vi.fn().mockResolvedValue([{ score: 0.9, payload: pointFor(calendar).payload }]),
      } as unknown as QdrantClient;
      const store = new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client);

      const found = await store.search("what's on my calendar", [weather, calendar], 1);

      expect(client.search).toHaveBeenCalledWith("caller_tools", {
        vector: [1, 2, 3],
        limit: 1,
        filter: { must: [{ has_id: [toQdrantPointId(weather.hash), toQdrantPointId(calendar.hash)] }] },
      });
      expect(found).toEqual([calendar]);
    });

    it("resolves hits back to the REQUEST's descriptors, ignoring any other point", async () => {
      // The payload is a cache entry any caller may have written; the request
      // body is what this turn is serving. A hash outside the supplied set must
      // never come back, even if Qdrant somehow returned it.
      const stranger = makeCallerTool("delete_everything", "not mine", { type: "object" });
      const client = {
        search: vi.fn().mockResolvedValue([
          { score: 0.99, payload: pointFor(stranger).payload },
          { score: 0.5, payload: pointFor(weather).payload },
        ]),
      } as unknown as QdrantClient;
      const store = new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client);

      expect(await store.search("anything", [weather], 5)).toEqual([weather]);
    });

    it("never asks for more results than there are candidates", async () => {
      const client = { search: vi.fn().mockResolvedValue([]) } as unknown as QdrantClient;
      await new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client).search("q", [weather], 10);
      expect(client.search).toHaveBeenCalledWith("caller_tools", expect.objectContaining({ limit: 1 }));
    });

    it("returns nothing (without embedding) for an empty candidate set", async () => {
      const client = { search: vi.fn() } as unknown as QdrantClient;
      const embedder = fakeEmbedder();
      expect(await new QdrantCallerToolStore(CONFIG, embedder, client).search("q", [], 5)).toEqual([]);
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(client.search).not.toHaveBeenCalled();
    });
  });

  describe("prune", () => {
    it("deletes definitions not seen since the cutoff", async () => {
      // Qdrant has no native TTL, hence a swept range filter.
      const client = {
        delete: vi.fn().mockResolvedValue({ status: "completed" }),
      } as unknown as QdrantClient;
      const store = new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client, () => 100_000);

      await store.prune(30_000);

      expect(client.delete).toHaveBeenCalledWith("caller_tools", {
        filter: { must: [{ key: "lastSeenAt", range: { lt: 70_000 } }] },
        wait: true,
      });
    });
  });

  describe("ensureCollection", () => {
    it("creates its OWN collection, never the catalog's", async () => {
      const client = {
        getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "tools" }, { name: "skills" }] }),
        createCollection: vi.fn(),
      } as unknown as QdrantClient;

      await new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client).ensureCollection();

      expect(client.createCollection).toHaveBeenCalledWith("caller_tools", {
        vectors: { size: 3, distance: "Cosine" },
      });
    });

    it("is idempotent once the collection exists", async () => {
      const client = {
        getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "caller_tools" }] }),
        createCollection: vi.fn(),
      } as unknown as QdrantClient;

      await new QdrantCallerToolStore(CONFIG, fakeEmbedder(), client).ensureCollection();

      expect(client.createCollection).not.toHaveBeenCalled();
    });
  });
});
