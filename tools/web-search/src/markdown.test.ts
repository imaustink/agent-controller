import { describe, expect, it } from "vitest";
import { renderResults } from "./markdown.js";

describe("renderResults", () => {
  it("renders a Markdown list of results", () => {
    const md = renderResults("pizza", [{ title: "Example", url: "https://example.com", content: "An example site" }], 10);
    expect(md).toContain('Search results for "pizza":');
    expect(md).toContain("- [Example](https://example.com): An example site");
  });

  it("omits the snippet when content is empty", () => {
    const md = renderResults("pizza", [{ title: "Example", url: "https://example.com", content: "" }], 10);
    expect(md).toContain("- [Example](https://example.com)");
    expect(md).not.toContain("):");
  });

  it("caps the number of rendered results", () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ title: `R${i}`, url: `https://example.com/${i}`, content: "" }));
    const md = renderResults("q", results, 2);
    expect(md).toContain("R0");
    expect(md).toContain("R1");
    expect(md).not.toContain("R2");
  });

  it("reports no results found", () => {
    expect(renderResults("nothing", [], 10)).toBe('No results found for "nothing".');
  });
});
