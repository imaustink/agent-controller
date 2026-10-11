import { describe, expect, it } from "vitest";
import { clip, redact } from "./redact.js";

describe("redact", () => {
  it("strips Bearer tokens", () => {
    expect(redact("Authorization: Bearer abcdef0123456789ABCDEF")).toContain("[REDACTED]");
  });

  it("strips `token <secret>` patterns", () => {
    expect(redact("failed with token abcdef0123456789ABCDEF")).toContain("[REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redact("Created note Plan")).toBe("Created note Plan");
  });
});

describe("clip", () => {
  it("truncates and appends an ellipsis when over the limit", () => {
    expect(clip("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("redacts before truncating", () => {
    expect(clip("Bearer abcdef0123456789ABCDEF")).toContain("[REDACTED]");
  });
});
