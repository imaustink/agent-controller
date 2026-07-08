import { describe, expect, it, vi } from "vitest";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantSkillStore } from "./qdrant-skill-store.js";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import type { SkillAccess, SkillDescriptor } from "./types.js";

const skill: SkillDescriptor = {
  id: "recipe-publisher-skill",
  name: "Recipe Extraction & Publishing",
  description: "Extract, adjust, and publish recipes",
  markdown: "# instructions",
  toolIds: ["recipe-scraper", "recipe-publisher"],
};

/** Derived audience as computed by derive-access.ts (ADR 0011). */
const skillAccess: SkillAccess = { skill, effectiveRoles: ["reader"] };

function fakeEmbedder(vector = [0.1, 0.2, 0.3]): Embedder {
  return { embed: vi.fn().mockResolvedValue(vector) };
}

describe("QdrantSkillStore", () => {
  it("creates the collection only if it doesn't already exist", async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "other" }] }),
      createCollection: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantClient;

    const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);
    await store.ensureCollection();

    expect(client.createCollection).toHaveBeenCalledWith("skills", { vectors: { size: 3, distance: "Cosine" } });
  });

  it("skips creating the collection if it already exists", async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: "skills" }] }),
      createCollection: vi.fn(),
    } as unknown as QdrantClient;

    const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);
    await store.ensureCollection();

    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it("upserts embedded skill descriptors as points with their derived audience", async () => {
    const client = { upsert: vi.fn().mockResolvedValue(true) } as unknown as QdrantClient;
    const embedder = fakeEmbedder([1, 2, 3]);
    const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, embedder, client);

    await store.upsert([skillAccess]);

    expect(embedder.embed).toHaveBeenCalledWith(skill.description);
    expect(client.upsert).toHaveBeenCalledWith("skills", {
      points: [
        {
          id: toQdrantPointId("recipe-publisher-skill"),
          vector: [1, 2, 3],
          payload: {
            id: "recipe-publisher-skill",
            name: skill.name,
            description: skill.description,
            markdown: skill.markdown,
            toolIds: skill.toolIds,
            effectiveRoles: ["reader"],
            unrestricted: false,
          },
        },
      ],
      wait: true,
    });
  });

  it("marks a tool-less skill (effectiveRoles: null) as unrestricted in the payload", async () => {
    const client = { upsert: vi.fn().mockResolvedValue(true) } as unknown as QdrantClient;
    const store = new QdrantSkillStore(
      { url: "http://q", collection: "skills", vectorSize: 3 },
      fakeEmbedder([1, 2, 3]),
      client,
    );
    const respondOnly: SkillDescriptor = { ...skill, id: "faq-skill", toolIds: [] };

    await store.upsert([{ skill: respondOnly, effectiveRoles: null }]);

    expect(client.upsert).toHaveBeenCalledWith("skills", {
      points: [
        expect.objectContaining({
          payload: expect.objectContaining({ effectiveRoles: [], unrestricted: true }),
        }),
      ],
      wait: true,
    });
  });

  it("fails closed: returns no results when callerRoles is empty, without querying Qdrant", async () => {
    const client = { search: vi.fn() } as unknown as QdrantClient;
    const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("extract a recipe", { callerRoles: [] });

    expect(results).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("scopes the search by derived effectiveRoles (or unrestricted) and maps results back to SkillDescriptor", async () => {
    const client = {
      search: vi.fn().mockResolvedValue([
        {
          id: toQdrantPointId("recipe-publisher-skill"),
          score: 0.9,
          payload: {
            id: "recipe-publisher-skill",
            name: skill.name,
            description: skill.description,
            markdown: skill.markdown,
            toolIds: skill.toolIds,
            effectiveRoles: ["reader"],
            unrestricted: false,
          },
        },
      ]),
    } as unknown as QdrantClient;
    const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

    const results = await store.query("extract a recipe", { callerRoles: ["reader"] }, 3);

    expect(client.search).toHaveBeenCalledWith("skills", {
      vector: [0.1, 0.2, 0.3],
      limit: 3,
      filter: {
        should: [
          { key: "unrestricted", match: { value: true } },
          { key: "effectiveRoles", match: { any: ["reader"] } },
        ],
      },
    });
    expect(results).toEqual([{ skill, score: 0.9 }]);
  });

  describe("getByIds (ADR 0012 -- active-skill re-fetch)", () => {
    const payload = {
      id: "recipe-publisher-skill",
      name: skill.name,
      description: skill.description,
      markdown: skill.markdown,
      toolIds: skill.toolIds,
      effectiveRoles: ["reader"],
      unrestricted: false,
    };

    it("fails closed: returns nothing when callerRoles is empty, without hitting Qdrant", async () => {
      const client = { retrieve: vi.fn() } as unknown as QdrantClient;
      const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

      await expect(store.getByIds(["recipe-publisher-skill"], { callerRoles: [] })).resolves.toEqual([]);
      expect(client.retrieve).not.toHaveBeenCalled();
    });

    it("returns nothing for an empty id list without hitting Qdrant", async () => {
      const client = { retrieve: vi.fn() } as unknown as QdrantClient;
      const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

      await expect(store.getByIds([], { callerRoles: ["reader"] })).resolves.toEqual([]);
      expect(client.retrieve).not.toHaveBeenCalled();
    });

    it("maps domain ids to Qdrant point ids and returns skills whose derived audience covers the caller", async () => {
      const client = {
        retrieve: vi.fn().mockResolvedValue([{ id: toQdrantPointId("recipe-publisher-skill"), payload }]),
      } as unknown as QdrantClient;
      const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

      const results = await store.getByIds(["recipe-publisher-skill"], { callerRoles: ["reader"] });

      expect(client.retrieve).toHaveBeenCalledWith("skills", {
        ids: [toQdrantPointId("recipe-publisher-skill")],
        with_payload: true,
      });
      expect(results).toEqual([skill]);
    });

    it("silently omits skills whose derived audience doesn't intersect the caller's roles", async () => {
      const client = {
        retrieve: vi.fn().mockResolvedValue([{ id: toQdrantPointId("recipe-publisher-skill"), payload }]),
      } as unknown as QdrantClient;
      const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

      await expect(store.getByIds(["recipe-publisher-skill"], { callerRoles: ["viewer"] })).resolves.toEqual([]);
    });

    it("returns unrestricted skills to any caller with a resolved role", async () => {
      const client = {
        retrieve: vi.fn().mockResolvedValue([
          {
            id: toQdrantPointId("faq-skill"),
            payload: { ...payload, id: "faq-skill", toolIds: [], effectiveRoles: [], unrestricted: true },
          },
        ]),
      } as unknown as QdrantClient;
      const store = new QdrantSkillStore({ url: "http://q", collection: "skills", vectorSize: 3 }, fakeEmbedder(), client);

      const results = await store.getByIds(["faq-skill"], { callerRoles: ["viewer"] });
      expect(results.map((s) => s.id)).toEqual(["faq-skill"]);
    });
  });
});
