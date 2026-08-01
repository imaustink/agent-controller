import { describe, expect, it } from "vitest";
import { mintSenderAssertion, verifySenderAssertion } from "./sender-assertion.js";

const SECRET = "e2e-assertion-secret";

describe("sender assertion", () => {
  it("round-trips a login", () => {
    expect(verifySenderAssertion(SECRET, mintSenderAssertion(SECRET, "imaustink"))).toBe("imaustink");
  });

  it("rejects an assertion signed with a different secret", () => {
    // The core property: holding the gateway's /invoke token is not enough to
    // name a login, because the login selects whose credentials the run gets.
    const forged = mintSenderAssertion("attacker-secret", "victim");
    expect(verifySenderAssertion(SECRET, forged)).toBeUndefined();
  });

  it("rejects a tampered payload even though the signature is well-formed", () => {
    const good = mintSenderAssertion(SECRET, "alice");
    const tampered = `${Buffer.from(JSON.stringify({ login: "victim", exp: 9999999999 }), "utf8").toString("base64url")}.${good.split(".")[1]}`;
    expect(verifySenderAssertion(SECRET, tampered)).toBeUndefined();
  });

  it("rejects an expired assertion", () => {
    const minted = mintSenderAssertion(SECRET, "alice", 60, Date.parse("2026-01-01T00:00:00Z"));
    expect(verifySenderAssertion(SECRET, minted, Date.parse("2026-01-01T00:02:00Z"))).toBeUndefined();
  });

  it("fails closed on missing, malformed, or unconfigured input", () => {
    expect(verifySenderAssertion(SECRET, undefined)).toBeUndefined();
    expect(verifySenderAssertion(SECRET, "not-an-assertion")).toBeUndefined();
    expect(verifySenderAssertion(SECRET, "only-one-part.")).toBeUndefined();
    // No secret configured -> never trust an assertion, rather than trusting all.
    expect(verifySenderAssertion("", mintSenderAssertion(SECRET, "alice"))).toBeUndefined();
  });
});
