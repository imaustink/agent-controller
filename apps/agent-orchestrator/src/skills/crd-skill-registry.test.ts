import { describe, expect, it, vi } from "vitest";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import { CrdSkillRegistry, type SkillCustomResource } from "./crd-skill-registry.js";

const validSkill: SkillCustomResource = {
  metadata: { name: "recipe-publisher-skill" },
  spec: {
    description: "Extract, adjust, and publish a recipe",
    markdown: "# Recipe Extraction & Publishing\n\n...",
    toolRefs: ["recipe-scraper", "recipe-publisher"],
  },
};

describe("CrdSkillRegistry", () => {
  it("maps Skill custom resources to SkillDescriptors", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [validSkill] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "tool.recipe-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "skills",
    });
    expect(skills).toEqual([
      {
        id: "recipe-publisher-skill",
        name: "recipe-publisher-skill",
        description: "Extract, adjust, and publish a recipe",
        markdown: "# Recipe Extraction & Publishing\n\n...",
        toolIds: ["recipe-scraper", "recipe-publisher"],
      },
    ]);
  });

  it("maps a respond-only Skill (no toolRefs, ADR 0011) with empty toolIds instead of skipping it", async () => {
    const respondOnly: SkillCustomResource = {
      metadata: { name: "faq-skill" },
      spec: { description: "Answers questions", markdown: "# FAQ" },
    };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [respondOnly] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(skills).toHaveLength(1);
    expect(skills[0].toolIds).toEqual([]);
  });

  it("skips a malformed Skill (missing markdown) rather than failing the whole catalog", async () => {
    const malformed = {
      metadata: { name: "broken-skill" },
      spec: { description: "no markdown" },
    } as SkillCustomResource;
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [malformed, validSkill] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("recipe-publisher-skill");
  });

  it("folds optional input/output fields into the embedded description", async () => {
    const withIo: SkillCustomResource = {
      metadata: { name: "io-skill" },
      spec: {
        ...validSkill.spec,
        input: "a recipe URL or an envelope JSON",
        output: "a refined envelope JSON or a publish confirmation",
      },
    };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [withIo] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(skills[0].description).toBe(
      "Extract, adjust, and publish a recipe\n\nInput: a recipe URL or an envelope JSON\nOutput: a refined envelope JSON or a publish confirmation",
    );
  });

  it("returns an empty catalog when there are zero Skill resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    expect(await registry.listAll()).toEqual([]);
  });
});
