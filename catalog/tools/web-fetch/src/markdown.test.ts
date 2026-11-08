import { describe, expect, it } from "vitest";
import { renderPage } from "./markdown.js";

describe("renderPage", () => {
  it("renders a title, source link, and body", () => {
    const md = renderPage("https://example.com", { title: "Example", text: "Hello world", readabilityUsed: true }, 1000);
    expect(md).toContain("# Example");
    expect(md).toContain("Source: https://example.com");
    expect(md).toContain("Hello world");
    expect(md).not.toContain("truncated");
    expect(md).not.toContain("raw text");
  });

  it("falls back to the URL as heading when there's no title", () => {
    const md = renderPage("https://example.com", { title: null, text: "Hello world", readabilityUsed: true }, 1000);
    expect(md).toContain("# https://example.com");
  });

  it("truncates long bodies and notes it", () => {
    const md = renderPage("https://example.com", { title: "Example", text: "a".repeat(100), readabilityUsed: true }, 10);
    expect(md).toContain("[content truncated at 10 characters]");
    expect(md).not.toContain("a".repeat(11));
  });

  it("reports when no readable content was found", () => {
    const md = renderPage("https://example.com", { title: "Example", text: "", readabilityUsed: false }, 1000);
    expect(md).toContain("No readable text content was found on this page.");
  });

  it("notes when Readability found no main content but raw text is used", () => {
    const md = renderPage("https://example.com", { title: "Example", text: "some text", readabilityUsed: false }, 1000);
    expect(md).toContain("raw text");
  });

  it("collapses excessive blank lines", () => {
    const md = renderPage("https://example.com", { title: "Example", text: "one\n\n\n\ntwo", readabilityUsed: true }, 1000);
    expect(md).toContain("one\n\ntwo");
  });
});
