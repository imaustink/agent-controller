import { describe, it, expect } from "vitest";
import { RecipeSchema, EnvelopeSchema, RECIPE_JSON_SCHEMA } from "./schema.js";

// The event-protocol schema (EventSchema, ArtifactRefSchema) now lives in the
// shared @recipe-agent/messaging package — see packages/messaging/src/emitter.test.ts.

describe("RecipeSchema", () => {
  it("accepts a well-formed recipe with a single unnamed section", () => {
    const recipe = {
      ingredientSections: [{ name: null, items: ["2 eggs"] }],
      directionSections: [{ name: null, items: ["Beat eggs"] }],
      equipment: ["whisk"],
      tips: ["Use fresh eggs"],
    };
    expect(RecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it("accepts multiple named sections", () => {
    const recipe = {
      ingredientSections: [
        { name: "Topping", items: ["1 cup sugar"] },
        { name: "Filling", items: ["2 cups flour"] },
      ],
      directionSections: [
        { name: "Topping", items: ["Mix sugar"] },
        { name: "Filling", items: ["Mix flour"] },
      ],
      equipment: [],
      tips: [],
    };
    expect(RecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it("rejects missing fields", () => {
    expect(() => RecipeSchema.parse({ ingredientSections: [] })).toThrow();
  });

  it("rejects wrong types", () => {
    expect(() =>
      RecipeSchema.parse({
        ingredientSections: "not-an-array",
        directionSections: [],
        equipment: [],
        tips: [],
      }),
    ).toThrow();
  });
});

describe("RECIPE_JSON_SCHEMA", () => {
  it("is strict-compatible: every property is required and additive props disallowed", () => {
    const props = Object.keys(RECIPE_JSON_SCHEMA.properties);
    expect(new Set(RECIPE_JSON_SCHEMA.required)).toEqual(new Set(props));
    expect(RECIPE_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("EnvelopeSchema", () => {
  it("validates a full envelope", () => {
    const envelope = {
      source_type: "web" as const,
      url: "https://example.com/recipe",
      title: "Test",
      recipe: {
        ingredientSections: [],
        directionSections: [],
        equipment: [],
        tips: [],
      },
      provenance: { extractor: "test" },
      warnings: [],
    };
    expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects an unknown source_type", () => {
    expect(() =>
      EnvelopeSchema.parse({
        source_type: "pdf",
        url: "https://example.com",
        title: null,
        recipe: { ingredientSections: [], directionSections: [], equipment: [], tips: [] },
        provenance: {},
        warnings: [],
      }),
    ).toThrow();
  });
});



