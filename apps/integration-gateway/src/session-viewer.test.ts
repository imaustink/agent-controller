import { describe, expect, it } from "vitest";
import { renderSessionPage, sessionViewerUrl, signSessionToken, verifySessionToken } from "./session-viewer.js";

describe("session-viewer tokens", () => {
  it("produces a deterministic token for the same secret/session id", () => {
    const a = signSessionToken("shh", "github:acme/widgets#7");
    const b = signSessionToken("shh", "github:acme/widgets#7");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different token for a different session id or secret", () => {
    const base = signSessionToken("shh", "github:acme/widgets#7");
    expect(signSessionToken("shh", "github:acme/widgets#8")).not.toBe(base);
    expect(signSessionToken("other", "github:acme/widgets#7")).not.toBe(base);
  });

  it("verifies a correctly signed token", () => {
    const token = signSessionToken("shh", "github:acme/widgets#7");
    expect(verifySessionToken("shh", "github:acme/widgets#7", token)).toBe(true);
  });

  it("rejects a missing, malformed, or mismatched token", () => {
    const token = signSessionToken("shh", "github:acme/widgets#7");
    expect(verifySessionToken("shh", "github:acme/widgets#7", null)).toBe(false);
    expect(verifySessionToken("shh", "github:acme/widgets#7", "not-hex-and-wrong-length")).toBe(false);
    expect(verifySessionToken("shh", "github:acme/widgets#7", "ab")).toBe(false);
    expect(verifySessionToken("shh", "github:acme/widgets#8", token)).toBe(false);
    expect(verifySessionToken("different-secret", "github:acme/widgets#7", token)).toBe(false);
  });

  it("builds a viewer URL embedding the encoded session id and its token", () => {
    const url = sessionViewerUrl("https://gateway.example.com/", "shh", "github:acme/widgets#7");
    expect(url).toBe(
      `https://gateway.example.com/sessions/${encodeURIComponent("github:acme/widgets#7")}?token=${signSessionToken("shh", "github:acme/widgets#7")}`,
    );
  });
});

describe("renderSessionPage", () => {
  it("renders an empty-transcript placeholder and no pending banner when settled", () => {
    const html = renderSessionPage("github:acme/widgets#7", "tok123", {
      sessionId: "github:acme/widgets#7",
      pending: false,
      transcript: [],
    });
    expect(html).toContain("No messages yet.");
    expect(html).not.toContain("still working");
    expect(html).not.toContain("http-equiv=\"refresh\"");
  });

  it("renders the pending banner and auto-refresh meta tag while a turn is in flight", () => {
    const html = renderSessionPage("github:acme/widgets#7", "tok123", {
      sessionId: "github:acme/widgets#7",
      pending: true,
      transcript: [],
    });
    expect(html).toContain("still working");
    expect(html).toContain('<meta http-equiv="refresh" content="10">');
  });

  it("renders transcript entries, escaping untrusted content", () => {
    const html = renderSessionPage("github:acme/widgets#7", "tok123", {
      sessionId: "github:acme/widgets#7",
      pending: false,
      transcript: [
        { role: "user", text: "<script>alert(1)</script>", at: 1 },
        { role: "agent", text: "Opened PR #12", at: 2 },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Opened PR #12");
  });

  it("renders a form posting back to this session's messages route with the token", () => {
    const html = renderSessionPage("github:acme/widgets#7", "tok123", undefined);
    expect(html).toContain(
      `action="/sessions/${encodeURIComponent("github:acme/widgets#7")}/messages?token=tok123"`,
    );
  });
});
