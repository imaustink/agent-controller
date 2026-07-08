import { describe, expect, it } from "vitest";
import { MarkdownInputSchema, parseTitle } from "./schema.js";

describe("MarkdownInputSchema", () => {
  it("accepts non-empty markdown", () => {
    expect(MarkdownInputSchema.parse("# Pancakes\n\n## Ingredients")).toBe("# Pancakes\n\n## Ingredients");
  });

  it("rejects an empty string", () => {
    expect(() => MarkdownInputSchema.parse("")).toThrow();
  });
});

describe("parseTitle", () => {
  it("extracts the title from a leading H1", () => {
    expect(parseTitle("# Grandma's Pancakes!\n\n## Ingredients")).toBe("Grandma's Pancakes!");
  });

  it("returns null when there is no H1 heading", () => {
    expect(parseTitle("## Ingredients\n\n1. Eggs")).toBeNull();
  });

  it("finds the H1 even if it isn't the first line", () => {
    expect(parseTitle("\n\n# Title Here\n\nbody")).toBe("Title Here");
  });
});
