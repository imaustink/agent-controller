import { describe, expect, it, vi } from "vitest";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantAgentStore } from "./qdrant-agent-store.js";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import type { AgentDescriptor } from "./types.js";

const agent: AgentDescriptor = {
  id: "software-engineering-agent",
  name: "software-engineering-agent",
  description: "Performs software-engineering work on GitHub",
  allowedRoles: ["writer"],
  tier: "privileged",
  orchestratorPrompt: "Delegate the whole request verbatim as the goal.",
  agentRunTemplate: { namespace: "default", agentRef: "software-engineering-agent" },
};

function fakeEmbedder(vector = [0.1, 0.2, 0.3]): Embedder {
  return { embed: vi.fn().mockResolvedValue(vector) };
}

describe("QdrantAgentStore", () => {
  it("creates the collection only if it doesn't already exist", async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "other" }] }),
      createCollection: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantClient;

    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);
    await store.ensureCollection();

    expect(client.createCollection).toHaveBeenCalledWith("agents", { vectors: { size: 3, distance: "Cosine" } });
  });

  it("upserts embedded agent descriptors as points", async () => {
    const client = { upsert: vi.fn().mockResolvedValue(true) } as unknown as QdrantClient;
    const embedder = fakeEmbedder([1, 2, 3]);
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, embedder, client);

    await store.upsert([agent]);

    expect(embedder.embed).toHaveBeenCalledWith(agent.description);
    expect(client.upsert).toHaveBeenCalledWith("agents", {
      points: [
        {
          id: toQdrantPointId("software-engineering-agent"),
          vector: [1, 2, 3],
          payload: {
            id: "software-engineering-agent",
            name: "software-engineering-agent",
            description: agent.description,
            allowedRoles: ["writer"],
            tier: "privileged",
            orchestratorPrompt: "Delegate the whole request verbatim as the goal.",
            namespace: "default",
            agentRef: "software-engineering-agent",
          },
        },
      ],
      wait: true,
    });
  });

  it("no-ops on an empty upsert (Qdrant rejects zero-point upserts)", async () => {
    const client = { upsert: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    await store.upsert([]);

    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("fails closed: returns no results when callerRoles is empty, without querying Qdrant", async () => {
    const client = { search: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("build a feature", { callerRoles: [] });

    expect(results).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("queries with an allowedRoles filter and maps results back to AgentDescriptors", async () => {
    const client = {
      search: vi.fn().mockResolvedValue([
        {
          score: 0.9,
          payload: {
            id: "software-engineering-agent",
            name: "software-engineering-agent",
            description: agent.description,
            allowedRoles: ["writer"],
            tier: "privileged",
            orchestratorPrompt: "Delegate the whole request verbatim as the goal.",
            namespace: "default",
            agentRef: "software-engineering-agent",
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("build a feature", { callerRoles: ["writer"] });

    expect(client.search).toHaveBeenCalledWith("agents", {
      vector: [0.1, 0.2, 0.3],
      limit: 5,
      filter: { must: [{ key: "allowedRoles", match: { any: ["writer"] } }] },
    });
    expect(results).toEqual([{ agent, score: 0.9 }]);
  });

  it("getByIds fails closed on empty callerRoles or empty ids", async () => {
    const client = { retrieve: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    expect(await store.getByIds(["x"], { callerRoles: [] })).toEqual([]);
    expect(await store.getByIds([], { callerRoles: ["writer"] })).toEqual([]);
    expect(client.retrieve).not.toHaveBeenCalled();
  });

  it("getByIds omits points whose allowedRoles don't intersect the caller's roles", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue([
        {
          payload: {
            id: "software-engineering-agent",
            name: "software-engineering-agent",
            description: agent.description,
            allowedRoles: ["admin"],
            tier: null,
            orchestratorPrompt: null,
            namespace: "default",
            agentRef: "software-engineering-agent",
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    expect(await store.getByIds(["software-engineering-agent"], { callerRoles: ["writer"] })).toEqual([]);
  });

  it("delete maps domain ids to Qdrant point ids", async () => {
    const client = { delete: vi.fn().mockResolvedValue(true) } as unknown as QdrantClient;
    const store = new QdrantAgentStore({ url: "http://q", collection: "agents", vectorSize: 3 }, fakeEmbedder(), client);

    await store.delete(["software-engineering-agent"]);

    expect(client.delete).toHaveBeenCalledWith("agents", {
      points: [toQdrantPointId("software-engineering-agent")],
      wait: true,
    });
  });
});
