import { describe, it, expect } from "vitest";
import { hasRecipeContent } from "./has-recipe-content.js";
import type { Recipe } from "./schema.js";

function recipe(overrides: Partial<Recipe>): Recipe {
  return {
    isRecipe: true,
    name: null,
    ingredientSections: [],
    directionSections: [],
    equipment: [],
    tips: [],
    ...overrides,
  };
}

describe("hasRecipeContent", () => {
  it("rejects a fully empty recipe", () => {
    expect(hasRecipeContent(recipe({}))).toBe(false);
  });

  it("rejects ingredients with no directions", () => {
    expect(hasRecipeContent(recipe({ ingredientSections: [{ name: null, items: ["2 eggs"] }] }))).toBe(false);
  });

  it("rejects directions with no ingredients", () => {
    expect(hasRecipeContent(recipe({ directionSections: [{ name: null, items: ["Bake at 350F"] }] }))).toBe(false);
  });

  it("rejects sections that exist but are empty", () => {
    expect(
      hasRecipeContent(
        recipe({
          ingredientSections: [{ name: null, items: [] }],
          directionSections: [{ name: null, items: [] }],
        }),
      ),
    ).toBe(false);
  });

  it("accepts a recipe with at least one ingredient and one direction", () => {
    expect(
      hasRecipeContent(
        recipe({
          ingredientSections: [{ name: null, items: ["2 eggs"] }],
          directionSections: [{ name: null, items: ["Bake at 350F"] }],
        }),
      ),
    ).toBe(true);
  });

  it("accepts content spread across a named subsection", () => {
    expect(
      hasRecipeContent(
        recipe({
          ingredientSections: [
            { name: "Crust", items: [] },
            { name: "Filling", items: ["1 cup sugar"] },
          ],
          directionSections: [{ name: null, items: ["Mix and bake"] }],
        }),
      ),
    ).toBe(true);
  });
});
