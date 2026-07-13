import { describe, expect, it } from "vitest";
import { clip, redact } from "./redact.js";

describe("redact", () => {
  it("redacts fine-grained PATs", () => {
    expect(redact("token github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz here")).toContain("[REDACTED]");
  });

  it("redacts installation/oauth tokens", () => {
    expect(redact("GH_TOKEN=ghs_0123456789abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem)).toBe("[REDACTED]");
  });

  it("redacts an embedded clone credential", () => {
    expect(redact("https://x-access-token:ghs_abc123@github.com/o/r.git")).not.toContain("ghs_abc123");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("cloned octo/hello and opened PR #12")).toBe("cloned octo/hello and opened PR #12");
  });
});

describe("clip", () => {
  it("truncates after redacting", () => {
    const out = clip("x".repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(11); // 10 chars + ellipsis
  });
});
