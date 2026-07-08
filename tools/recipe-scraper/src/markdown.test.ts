import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";
import type { Envelope } from "./schema.js";

describe("renderMarkdown", () => {
  it("renders a single-section recipe as a flat numbered list under each heading", () => {
    const envelope: Envelope = {
      source_type: "web",
      url: "https://example.com/recipe",
      title: "Pancakes",
      recipe: {
        ingredientSections: [{ name: null, items: ["2 eggs", "1 cup flour"] }],
        directionSections: [{ name: null, items: ["Mix", "Cook"] }],
        equipment: ["whisk"],
        tips: ["Use fresh eggs"],
      },
      provenance: {},
      warnings: [],
    };

    expect(renderMarkdown(envelope)).toBe(
      [
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
        "1. whisk",
        "",
        "## Tips",
        "",
        "1. Use fresh eggs",
        "",
        "[Source](https://example.com/recipe)",
      ].join("\n"),
    );
  });

  it("renders multi-component recipes with ### subsections, matching the requested format", () => {
    const envelope: Envelope = {
      source_type: "web",
      url: "https://example.com/muffins",
      title: "Bakery Style Blueberry Muffins",
      recipe: {
        ingredientSections: [
          { name: "Crumble Topping Ingredients", items: ["4 tbsp butter, melted", "1/2 cup sugar"] },
          { name: "Muffin Ingredients", items: ["2 cups flour", "2 cups blueberries"] },
        ],
        directionSections: [
          { name: "Crumble Topping Instructions", items: ["Stir all ingredients with a fork until clumped together."] },
          { name: "Muffin Instructions", items: ["Cream butter and sugar.", "Bake at 375°F for 30 minutes."] },
        ],
        equipment: ["Mixing bowls", "Oven"],
        tips: ["Ensure butter is softened for easier mixing."],
      },
      provenance: {},
      warnings: [],
    };

    expect(renderMarkdown(envelope)).toBe(
      [
        "# Bakery Style Blueberry Muffins",
        "",
        "## Ingredients",
        "",
        "### Crumble Topping Ingredients",
        "1. 4 tbsp butter, melted",
        "2. 1/2 cup sugar",
        "",
        "### Muffin Ingredients",
        "1. 2 cups flour",
        "2. 2 cups blueberries",
        "",
        "## Directions",
        "",
        "### Crumble Topping Instructions",
        "1. Stir all ingredients with a fork until clumped together.",
        "",
        "### Muffin Instructions",
        "1. Cream butter and sugar.",
        "2. Bake at 375°F for 30 minutes.",
        "",
        "## Equipment",
        "",
        "1. Mixing bowls",
        "2. Oven",
        "",
        "## Tips",
        "",
        "1. Ensure butter is softened for easier mixing.",
        "",
        "[Source](https://example.com/muffins)",
      ].join("\n"),
    );
  });

  it("omits the Equipment/Tips headings entirely when empty", () => {
    const envelope: Envelope = {
      source_type: "web",
      url: "https://example.com/recipe",
      title: null,
      recipe: {
        ingredientSections: [{ name: null, items: ["2 eggs"] }],
        directionSections: [{ name: null, items: ["Mix"] }],
        equipment: [],
        tips: [],
      },
      provenance: {},
      warnings: [],
    };

    const markdown = renderMarkdown(envelope);
    expect(markdown).not.toContain("## Equipment");
    expect(markdown).not.toContain("## Tips");
    expect(markdown).toContain("# Untitled Recipe");
  });
});
