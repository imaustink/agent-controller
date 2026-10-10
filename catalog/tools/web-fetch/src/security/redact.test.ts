import { describe, it, expect } from "vitest";
import { redact, clip } from "./redact.js";

describe("redact", () => {
  it("removes OpenAI-style keys", () => {
    expect(redact("token sk-abcdefghijklmnopqrstuvwx used")).toBe("token [REDACTED] used");
  });

  it("removes bearer tokens", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrst")).toContain("[REDACTED]");
  });

  it("leaves clean text untouched", () => {
    expect(redact("just a normal page")).toBe("just a normal page");
  });
});

describe("clip", () => {
  it("truncates long input", () => {
    const out = clip("a".repeat(1000), 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(21); // 20 chars + ellipsis
  });

  it("redacts secrets before returning", () => {
    const out = clip("leaked sk-abcdefghijklmnopqrstuvwx here", 500);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-abcdefghijklmnop");
  });
});
