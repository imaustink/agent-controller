import { describe, expect, it } from "vitest";
import { clip, redact } from "./redact.js";

describe("redact", () => {
  it("redacts an OpenAI-style key", () => {
    expect(redact("key: sk-abcdefghijklmnopqrstuvwxyz")).toBe("key: [REDACTED]");
  });

  it("redacts a bearer token", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwx")).toBe("Authorization: [REDACTED]");
  });

  it("redacts a Mealie-style long-lived API token used as a bearer token", () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(20)}`;
    expect(redact(`Authorization: Bearer ${token}`)).toBe("Authorization: [REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redact("Recipe for pancakes")).toBe("Recipe for pancakes");
  });
});

describe("clip", () => {
  it("truncates long strings and redacts secrets first", () => {
    const token = `sk-${"a".repeat(36)}`;
    const result = clip(`${"x".repeat(10)}${token}`, 5);
    expect(result.startsWith("xxxxx")).toBe(true);
    expect(result).not.toContain(token);
  });
});
