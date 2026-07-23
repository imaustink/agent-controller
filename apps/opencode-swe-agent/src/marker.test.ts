import { describe, expect, it } from "vitest";
import { decodeSweContinuation, encodeSweContinuation } from "./marker.js";

describe("encodeSweContinuation / decodeSweContinuation", () => {
  it("round-trips a marker with a pull request", () => {
    const marker = { repo: "owner/repo", branch: "feature/x", pr: "12", session: "abc-123" };
    expect(decodeSweContinuation(encodeSweContinuation(marker))).toEqual(marker);
  });

  it("round-trips a marker with no pull request yet", () => {
    const marker = { repo: "owner/repo", branch: "feature/x", pr: null, session: "abc-123" };
    expect(decodeSweContinuation(encodeSweContinuation(marker))).toEqual(marker);
  });

  it("decodes null for a null token", () => {
    expect(decodeSweContinuation(null)).toBeNull();
  });

  it("decodes null (fails closed) for a malformed repo", () => {
    expect(decodeSweContinuation("repo=not-a-repo branch=main session=abc")).toBeNull();
  });

  it("decodes null (fails closed) for a non-numeric pr", () => {
    expect(decodeSweContinuation("repo=owner/repo branch=main pr=abc session=abc")).toBeNull();
  });

  it("decodes null (fails closed) for a missing session", () => {
    expect(decodeSweContinuation("repo=owner/repo branch=main")).toBeNull();
  });

  it("rejects a branch value containing shell metacharacters", () => {
    expect(decodeSweContinuation("repo=owner/repo branch=main;rm session=abc")).toBeNull();
  });
});
