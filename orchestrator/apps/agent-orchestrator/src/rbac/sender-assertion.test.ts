import { describe, expect, it } from "vitest";
import { mintSenderAssertion, verifySenderAssertion, verifySenderClaims } from "./sender-assertion.js";

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

// docs/adr/0049 §5: integration-gateway's extended claim set. The vector is
// minted by the GATEWAY's own mintSenderAssertion (exp 2100-01-01), the same
// one the Go verifier's test uses, so all three implementations agree.
describe("sender claims", () => {
  const VECTOR =
    "eyJsb2dpbiI6ImFsaWNlIiwiYWNjb3VudElkIjoiNTgzMjMxIiwic3ViamVjdFN0YXR1cyI6ImxpbmtlZCIsInN1YmplY3QiOiJvcGVud2VidWk6YSIsImV4cCI6NDEwMjQ0NDgwMH0.zZp81J2ee26VtYhc9IndlPieNkCe0M7MqHMc_1LkH_4";

  it("verifies a gateway-minted claim set, and the login-only verifier still reads it", () => {
    expect(verifySenderClaims("cross-language-secret", VECTOR)).toEqual({
      login: "alice",
      accountId: "583231",
      subject: "openwebui:a",
      subjectStatus: "linked",
    });
    expect(verifySenderAssertion("cross-language-secret", VECTOR)).toBe("alice");
  });

  it("never returns a subject that is not the linked one", () => {
    const minted = mintSenderAssertion("s", { login: "alice", subject: "openwebui:x", subjectStatus: "ambiguous" });
    expect(verifySenderClaims("s", minted)).toEqual({ login: "alice", subjectStatus: "ambiguous" });
  });
});
