import { describe, expect, it } from "vitest";
import { clip, redact } from "./redact.js";

describe("redact", () => {
  // Real-shaped GitHub tokens are `<prefix>_` followed by a long base62 body.
  // The whole point of this tool is spawning a subprocess with a live token and
  // scrubbing it out of anything that echoes back, so these patterns are the
  // last line of defense on the failure path (gh's own verbose auth errors can
  // print the token they were handed).
  it.each([
    ["ghp_", "ghp_0123456789abcdefABCDEFghijklmnopqr"], // classic PAT
    ["gho_", "gho_0123456789abcdefABCDEFghijklmnopqr"], // OAuth token
    ["ghu_", "ghu_0123456789abcdefABCDEFghijklmnopqr"], // user-to-server
    ["ghs_", "ghs_0123456789abcdefABCDEFghijklmnopqr"], // server-to-server
    ["ghr_", "ghr_0123456789abcdefABCDEFghijklmnopqr"], // refresh token
  ])("redacts a %s-prefixed GitHub token", (_prefix, token) => {
    const out = redact(`authenticating with ${token} failed`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a token embedded mid-string without eating the surrounding text", () => {
    const out = redact("before ghp_0123456789abcdefABCDEFghij after");
    expect(out).toBe("before [REDACTED] after");
  });

  it("redacts multiple tokens in one string", () => {
    const out = redact(
      "gho_0123456789abcdefABCDEFghij and ghs_zyxwvutsrqponmlkjihgfedcba9876",
    );
    expect(out).not.toMatch(/gh[oprsu]_/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts a Bearer authorization header value", () => {
    const out = redact("Authorization: Bearer abcDEF123456._-ghijkl");
    expect(out).not.toContain("abcDEF123456._-ghijkl");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a `token <value>` credential (case-insensitively)", () => {
    const out = redact("Authorization: TOKEN abcDEF123456ghijklmnop");
    expect(out).not.toContain("abcDEF123456ghijklmnop");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text with no secrets untouched", () => {
    const clean = "issue #86 opened by octocat in imaustink/agent-controller";
    expect(redact(clean)).toBe(clean);
  });

  it("does not over-match a short `gh`-prefixed word that isn't a token", () => {
    // Below the 20-char body threshold -> not a credential shape.
    expect(redact("ghp_short")).toBe("ghp_short");
  });
});

describe("clip", () => {
  it("redacts before truncating so a token split by the cut can't leak", () => {
    const token = "ghp_0123456789abcdefABCDEFghijklmnopqr";
    // Put the token right at the truncation boundary.
    const input = `${"x".repeat(10)}${token}${"y".repeat(50)}`;
    const out = clip(input, 25);
    expect(out).not.toContain(token);
    expect(out).not.toContain("ghp_");
  });

  it("appends an ellipsis when the (redacted) input exceeds max", () => {
    const out = clip("a".repeat(100), 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(11); // 10 chars + the ellipsis
  });

  it("returns short input unchanged", () => {
    expect(clip("short", 4000)).toBe("short");
  });
});
