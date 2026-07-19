import { describe, expect, it } from "vitest";
import { QueryInputSchema, SearxngResponseSchema } from "./schema.js";

describe("QueryInputSchema", () => {
  it("accepts a non-empty query", () => {
    expect(QueryInputSchema.parse("best pizza recipe")).toBe("best pizza recipe");
  });

  it("trims whitespace", () => {
    expect(QueryInputSchema.parse("  hello  ")).toBe("hello");
  });

  it("rejects an empty string", () => {
    expect(() => QueryInputSchema.parse("")).toThrow();
  });

  it("rejects a whitespace-only string", () => {
    expect(() => QueryInputSchema.parse("   ")).toThrow();
  });

  it("rejects an overly long query", () => {
    expect(() => QueryInputSchema.parse("a".repeat(2001))).toThrow();
  });
});

describe("SearxngResponseSchema", () => {
  it("parses a well-formed response", () => {
    const parsed = SearxngResponseSchema.parse({
      results: [{ title: "Example", url: "https://example.com", content: "An example site" }],
    });
    expect(parsed.results).toHaveLength(1);
  });

  it("defaults content to an empty string when missing", () => {
    const parsed = SearxngResponseSchema.parse({ results: [{ title: "Example", url: "https://example.com" }] });
    expect(parsed.results[0]!.content).toBe("");
  });

  it("rejects a response missing results", () => {
    expect(() => SearxngResponseSchema.parse({})).toThrow();
  });
});
