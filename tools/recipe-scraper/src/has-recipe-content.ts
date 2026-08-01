import type { Recipe } from "./schema.js";

/**
 * A recipe is only worth publishing if it has at least one real ingredient
 * AND one real direction -- Structured Outputs (schema.ts) only guarantees
 * the model's output has the right *shape*, not that it actually found a
 * recipe in the source text. Content that isn't a recipe at all (an error
 * page, an unrelated article, a blocked/paywalled page) can still produce a
 * schema-valid `Recipe` with every section empty.
 */
export function hasRecipeContent(recipe: Recipe): boolean {
  const hasItems = (sections: Recipe["ingredientSections"]) => sections.some((section) => section.items.length > 0);
  return hasItems(recipe.ingredientSections) && hasItems(recipe.directionSections);
}
