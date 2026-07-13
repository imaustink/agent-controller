import { describe, expect, it, vi } from "vitest";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantToolStore } from "./qdrant-store.js";
import { toQdrantPointId } from "./qdrant-id.js";
import type { Embedder } from "./types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool: ToolDescriptor = {
  id: "recipe-scraper",
  name: "recipe-scraper",
  description: "Scrapes a recipe from a URL",
  allowedRoles: ["reader"],
  jobTemplate: { image: "example.com/tool:latest", namespace: "default", serviceAccountName: "tool-sa" },
};

function fakeEmbedder(vector = [0.1, 0.2, 0.3]): Embedder {
  return { embed: vi.fn().mockResolvedValue(vector) };
}

describe("QdrantToolStore", () => {
  it("creates the collection only if it doesn't already exist", async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "other" }] }),
      createCollection: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantClient;

    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);
    await store.ensureCollection();

    expect(client.createCollection).toHaveBeenCalledWith("tools", { vectors: { size: 3, distance: "Cosine" } });
  });

  it("skips creating the collection if it already exists", async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "tools" }] }),
      createCollection: vi.fn(),
    } as unknown as QdrantClient;

    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);
    await store.ensureCollection();

    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it("upserts embedded tool descriptors as points", async () => {
    const client = { upsert: vi.fn().mockResolvedValue(true) } as unknown as QdrantClient;
    const embedder = fakeEmbedder([1, 2, 3]);
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, embedder, client);

    await store.upsert([tool]);

    expect(embedder.embed).toHaveBeenCalledWith(tool.description);
    expect(client.upsert).toHaveBeenCalledWith("tools", {
      points: [
        {
          id: toQdrantPointId("recipe-scraper"),
          vector: [1, 2, 3],
          payload: {
            id: "recipe-scraper",
            name: "recipe-scraper",
            description: tool.description,
            allowedRoles: ["reader"],
            jobTemplate: tool.jobTemplate,
            localExec: null,
            tier: null,
          },
        },
      ],
      wait: true,
    });
  });

  it("fails closed: returns no results when callerRoles is empty, without querying Qdrant", async () => {
    const client = { search: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("find a recipe tool", { callerRoles: [] });

    expect(results).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("scopes the search with an allowedRoles filter and maps results back to ToolDescriptor", async () => {
    const client = {
      search: vi.fn().mockResolvedValue([
        {
          id: toQdrantPointId("recipe-scraper"),
          score: 0.9,
          payload: {
            id: "recipe-scraper",
            name: "recipe-scraper",
            description: tool.description,
            allowedRoles: ["reader"],
            jobTemplate: tool.jobTemplate,
            tier: null,
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("find a recipe tool", { callerRoles: ["reader"] }, 3);

    expect(client.search).toHaveBeenCalledWith("tools", {
      vector: [0.1, 0.2, 0.3],
      limit: 3,
      filter: { must: [{ key: "allowedRoles", match: { any: ["reader"] } }] },
    });
    expect(results).toEqual([{ tool, score: 0.9 }]);
  });

  it("getByIds fails closed: returns no results when callerRoles is empty, without calling Qdrant", async () => {
    const client = { retrieve: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.getByIds(["recipe-scraper"], { callerRoles: [] });

    expect(results).toEqual([]);
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("getByIds returns [] without calling Qdrant when given no ids", async () => {
    const client = { retrieve: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.getByIds([], { callerRoles: ["reader"] });

    expect(results).toEqual([]);
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("getByIds resolves points directly by id and maps them back to ToolDescriptor", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue([
        {
          id: toQdrantPointId("recipe-scraper"),
          payload: {
            id: "recipe-scraper",
            name: "recipe-scraper",
            description: tool.description,
            allowedRoles: ["reader"],
            jobTemplate: tool.jobTemplate,
            tier: null,
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.getByIds(["recipe-scraper"], { callerRoles: ["reader"] });

    expect(client.retrieve).toHaveBeenCalledWith("tools", {
      ids: [toQdrantPointId("recipe-scraper")],
      with_payload: true,
    });
    expect(results).toEqual([{ tool, score: 1 }]);
  });

  it("getByIds filters out points whose allowedRoles don't intersect the caller's roles", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue([
        {
          id: toQdrantPointId("recipe-scraper"),
          payload: {
            id: "recipe-scraper",
            name: "recipe-scraper",
            description: tool.description,
            allowedRoles: ["admin-only"],
            jobTemplate: tool.jobTemplate,
            tier: null,
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantToolStore({ url: "http://q", collection: "tools", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.getByIds(["recipe-scraper"], { callerRoles: ["reader"] });

    expect(results).toEqual([]);
  });
});
