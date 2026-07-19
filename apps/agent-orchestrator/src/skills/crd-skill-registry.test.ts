import { describe, expect, it, vi } from "vitest";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
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
    const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
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
    const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

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
    const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

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
    const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const skills = await registry.listAll();

    expect(skills[0].description).toBe(
      "Extract, adjust, and publish a recipe\n\nInput: a recipe URL or an envelope JSON\nOutput: a refined envelope JSON or a publish confirmation",
    );
  });

  it("returns an empty catalog when there are zero Skill resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    expect(await registry.listAll()).toEqual([]);
  });

  describe("watch", () => {
    it("maps ADDED to an upsert event and DELETED to a delete event", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts.plural).toBe("skills");
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("ADDED", validSkill);
      expect(onChange).toHaveBeenCalledWith({
        type: "upsert",
        descriptor: expect.objectContaining({ id: "recipe-publisher-skill" }),
      });

      onEvent("DELETED", validSkill);
      expect(onChange).toHaveBeenCalledWith({ type: "delete", id: "recipe-publisher-skill" });
    });

    it("throws when constructed without a watchFn", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      const registry = new CrdSkillRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      expect(() => registry.watch(() => {})).toThrow();
    });
  });
});
