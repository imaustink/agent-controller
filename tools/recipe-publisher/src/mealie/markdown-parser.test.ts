import { describe, expect, it } from "vitest";
import { extractMealieSlugMarker, parseRecipeMarkdown, renderMealieSlugMarker } from "./markdown-parser.js";

describe("parseRecipeMarkdown", () => {
  it("parses a flat single-section recipe", () => {
    const markdown = [
      "# Pancakes",
      "",
      "## Ingredients",
      "",
      "1. 2 eggs",
      "2. 1 cup flour",
      "",
      "## Directions",
      "",
      "1. Mix",
      "2. Cook",
      "",
      "## Equipment",
      "",
      "1. Bowl",
      "",
      "## Tips",
      "",
      "1. Don't overmix",
      "",
      "[Source](https://example.com/recipe)",
    ].join("\n");

    const parsed = parseRecipeMarkdown(markdown);
    expect(parsed.title).toBe("Pancakes");
    expect(parsed.ingredientSections).toEqual([{ name: null, items: ["2 eggs", "1 cup flour"] }]);
    expect(parsed.directionSections).toEqual([{ name: null, items: ["Mix", "Cook"] }]);
    expect(parsed.equipment).toEqual(["Bowl"]);
    expect(parsed.tips).toEqual(["Don't overmix"]);
    expect(parsed.sourceUrl).toBe("https://example.com/recipe");
  });

  it("parses multi-component sections with ### subheadings", () => {
    const markdown = [
      "# Birria Tacos",
      "",
      "## Ingredients",
      "",
      "### Birria",
      "1. Beef chuck",
      "",
      "### Quesa Tacos",
      "1. Tortillas",
      "2. Cheese",
      "",
      "## Directions",
      "",
      "### Birria",
      "1. Braise the beef",
      "",
      "### Quesa Tacos",
      "1. Assemble and fry",
      "",
      "[Source](https://example.com/birria)",
    ].join("\n");

    const parsed = parseRecipeMarkdown(markdown);
    expect(parsed.ingredientSections).toEqual([
      { name: "Birria", items: ["Beef chuck"] },
      { name: "Quesa Tacos", items: ["Tortillas", "Cheese"] },
    ]);
    expect(parsed.directionSections).toEqual([
      { name: "Birria", items: ["Braise the beef"] },
      { name: "Quesa Tacos", items: ["Assemble and fry"] },
    ]);
    expect(parsed.equipment).toEqual([]);
    expect(parsed.tips).toEqual([]);
  });

  it("handles missing optional sections and no source link", () => {
    const parsed = parseRecipeMarkdown("# Just A Title\n\n## Ingredients\n\n1. Water");
    expect(parsed.title).toBe("Just A Title");
    expect(parsed.equipment).toEqual([]);
    expect(parsed.tips).toEqual([]);
    expect(parsed.sourceUrl).toBeNull();
    expect(parsed.directionSections).toEqual([]);
  });

  it("returns a null title when there is no H1 heading", () => {
    expect(parseRecipeMarkdown("## Ingredients\n\n1. Eggs").title).toBeNull();
  });

  it("parses ### top-level sections (no ## used at all)", () => {
    const markdown = [
      "Here's a recipe:",
      "",
      "### Ingredients",
      "- 2 cups fresh peaches",
      "- 1 cup sugar",
      "",
      "### Instructions",
      "1. Simmer the peaches and sugar.",
      "2. Strain and cool.",
    ].join("\n");

    const parsed = parseRecipeMarkdown(markdown);
    expect(parsed.ingredientSections).toEqual([{ name: null, items: ["2 cups fresh peaches", "1 cup sugar"] }]);
    expect(parsed.directionSections).toEqual([
      { name: null, items: ["Simmer the peaches and sugar.", "Strain and cool."] },
    ]);
  });

  it.each(["Instructions", "Steps", "Method", "Preparation"])(
    "treats '%s' as a synonym for the Directions heading",
    (label) => {
      const markdown = ["# Pancakes", "", "## Ingredients", "", "1. 2 eggs", "", `## ${label}`, "", "1. Mix"].join(
        "\n",
      );
      expect(parseRecipeMarkdown(markdown).directionSections).toEqual([{ name: null, items: ["Mix"] }]);
    },
  );

  it("still nests multi-component subsections one level deeper when the parent section uses ###", () => {
    const markdown = [
      "### Ingredients",
      "#### Crust",
      "1. Flour",
      "",
      "#### Filling",
      "1. Sugar",
      "",
      "### Directions",
      "1. Mix and bake",
    ].join("\n");

    const parsed = parseRecipeMarkdown(markdown);
    expect(parsed.ingredientSections).toEqual([
      { name: "Crust", items: ["Flour"] },
      { name: "Filling", items: ["Sugar"] },
    ]);
    expect(parsed.directionSections).toEqual([{ name: null, items: ["Mix and bake"] }]);
  });

  it.each(["-", "*", "•"])("parses %s-bulleted lists the same as numbered lists", (marker) => {
    const markdown = [
      "# Pancakes",
      "",
      "## Ingredients",
      "",
      `${marker} 2 eggs`,
      `${marker} 1 cup flour`,
      "",
      "## Directions",
      "",
      `${marker} Mix`,
      `${marker} Cook`,
    ].join("\n");

    const parsed = parseRecipeMarkdown(markdown);
    expect(parsed.ingredientSections).toEqual([{ name: null, items: ["2 eggs", "1 cup flour"] }]);
    expect(parsed.directionSections).toEqual([{ name: null, items: ["Mix", "Cook"] }]);
  });
});

describe("extractMealieSlugMarker / renderMealieSlugMarker", () => {
  it("extracts a leading marker and strips it from the returned markdown", () => {
    const markdown = `${renderMealieSlugMarker("birria-tacos")}# Birria Tacos\n\n## Ingredients\n\n1. Beef chuck`;
    const { slug, markdown: stripped } = extractMealieSlugMarker(markdown);
    expect(slug).toBe("birria-tacos");
    expect(stripped).toBe("# Birria Tacos\n\n## Ingredients\n\n1. Beef chuck");
  });

  it("returns a null slug and the markdown unchanged when no marker is present", () => {
    const markdown = "# Pancakes\n\n## Ingredients\n\n1. 2 eggs";
    expect(extractMealieSlugMarker(markdown)).toEqual({ slug: null, markdown });
  });

  it("is case-insensitive on the marker keyword but lowercases the extracted slug", () => {
    const { slug } = extractMealieSlugMarker("<!-- Continuation: Birria-Tacos -->\n\n# Birria Tacos");
    expect(slug).toBe("birria-tacos");
  });

  it("ignores a marker that isn't at the very start of the text", () => {
    const markdown = "# Pancakes\n\n<!-- continuation: pancakes -->\n\n## Ingredients";
    expect(extractMealieSlugMarker(markdown).slug).toBeNull();
  });
});
