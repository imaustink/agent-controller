import { describe, expect, it } from "vitest";
import { signState, verifyState } from "./oauthState.js";

describe("signState/verifyState", () => {
  const secret = "super-secret";
  const now = 1_700_000_000_000;

  it("round-trips the original payload", () => {
    const token = signState({ provider: "github", subject: "user-123" }, secret, now);
    const result = verifyState(token, secret, 600, now);
    expect(result).toEqual({ provider: "github", subject: "user-123" });
  });

  it("rejects a tampered payload segment", () => {
    const token = signState({ provider: "github", subject: "user-123" }, secret, now);
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ provider: "github", subject: "attacker", iat: Math.floor(now / 1000) }))
      .toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(verifyState(tampered, secret, 600, now)).toBeUndefined();
  });

  it("rejects a tampered signature segment", () => {
    const token = signState({ provider: "github", subject: "user-123" }, secret, now);
    const [payload] = token.split(".");
    const tampered = `${payload}.${Buffer.from("not-the-real-signature").toString("base64url")}`;
    expect(verifyState(tampered, secret, 600, now)).toBeUndefined();
  });

  it("rejects an expired token (iat older than maxAgeSeconds)", () => {
    const token = signState({ provider: "github", subject: "user-123" }, secret, now);
    const result = verifyState(token, secret, 600, now + 601 * 1000);
    expect(result).toBeUndefined();
  });

  it("rejects a malformed token missing the '.' separator", () => {
    expect(verifyState("not-a-valid-token", secret, 600, now)).toBeUndefined();
  });

  it("rejects a malformed token with non-base64 content", () => {
    expect(verifyState("not!!base64.also!!not", secret, 600, now)).toBeUndefined();
  });

  it("rejects a token verified with the wrong secret", () => {
    const token = signState({ provider: "github", subject: "user-123" }, secret, now);
    expect(verifyState(token, "wrong-secret", 600, now)).toBeUndefined();
  });
});
