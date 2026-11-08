import { describe, expect, it } from "vitest";
import { UrlInputSchema } from "./schema.js";

describe("UrlInputSchema", () => {
  it("accepts a non-empty URL", () => {
    expect(UrlInputSchema.parse("https://example.com")).toBe("https://example.com");
  });

  it("trims whitespace", () => {
    expect(UrlInputSchema.parse("  https://example.com  ")).toBe("https://example.com");
  });

  it("rejects an empty string", () => {
    expect(() => UrlInputSchema.parse("")).toThrow();
  });

  it("rejects a whitespace-only string", () => {
    expect(() => UrlInputSchema.parse("   ")).toThrow();
  });

  it("rejects an overly long URL", () => {
    expect(() => UrlInputSchema.parse(`https://example.com/${"a".repeat(2001)}`)).toThrow();
  });
});
