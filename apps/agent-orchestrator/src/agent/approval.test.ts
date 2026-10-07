import { describe, expect, it } from "vitest";
import {
  APPROVAL_DENIED_MESSAGE,
  approvalPrompt,
  parseApprovalDecision,
  requiresApproval,
  resolveApproval,
} from "./approval.js";

describe("resolveApproval (ADR 0003 most-specific-wins)", () => {
  it("prefers the tool's own policy over the agent default", () => {
    expect(resolveApproval("always", "never")).toBe("always");
    expect(resolveApproval("never", "always")).toBe("never");
    expect(resolveApproval("auto", "never")).toBe("auto");
  });

  it("falls back to the agent default when the tool sets none", () => {
    expect(resolveApproval(undefined, "always")).toBe("always");
    expect(resolveApproval("", "auto")).toBe("auto");
  });

  it("falls back to never when neither is set", () => {
    expect(resolveApproval(undefined, undefined)).toBe("never");
  });

  it("treats an empty string as unset at every level (existing CRs unaffected)", () => {
    // The core compatibility guarantee: an empty policy must resolve to never,
    // never escalate. If this flipped to always, every pre-ADR-0003 CR would
    // suddenly start pausing for approval.
    expect(resolveApproval("", "")).toBe("never");
    expect(resolveApproval("   ", undefined)).toBe("never");
  });

  it("is case-insensitive and ignores unrecognized values", () => {
    expect(resolveApproval("ALWAYS", undefined)).toBe("always");
    expect(resolveApproval("bogus", "always")).toBe("always");
    expect(resolveApproval("bogus", "also-bogus")).toBe("never");
  });
});

describe("requiresApproval", () => {
  it("gates always and auto (auto behaves as always for now)", () => {
    expect(requiresApproval("always")).toBe(true);
    expect(requiresApproval("auto")).toBe(true);
  });
  it("never runs silently", () => {
    expect(requiresApproval("never")).toBe(false);
  });
});

describe("parseApprovalDecision (deterministic, case-insensitive, trimmed)", () => {
  it.each(["approve", "approved", "yes", "y", "ok", "okay", "allow", "allowed", "confirm", "confirmed"])(
    "approves on %s",
    (word) => {
      expect(parseApprovalDecision(word)).toBe("approve");
      expect(parseApprovalDecision(`  ${word.toUpperCase()}  `)).toBe("approve");
    },
  );

  it.each(["deny", "denied", "no", "n", "reject", "rejected", "cancel", "cancelled", "stop", "disallow"])(
    "denies on %s",
    (word) => {
      expect(parseApprovalDecision(word)).toBe("deny");
      expect(parseApprovalDecision(`  ${word.toUpperCase()}  `)).toBe("deny");
    },
  );

  it("is ambiguous for anything else", () => {
    expect(parseApprovalDecision("maybe")).toBe("ambiguous");
    expect(parseApprovalDecision("run it later")).toBe("ambiguous");
    expect(parseApprovalDecision("")).toBe("ambiguous");
    expect(parseApprovalDecision(undefined)).toBe("ambiguous");
    // A word CONTAINING an approve token is not a bare decision.
    expect(parseApprovalDecision("yessir")).toBe("ambiguous");
  });

  it("strips a single trailing punctuation mark, matching the Go engine", () => {
    // PARITY: Go ParseDecision strips trailing .!, — "approve." must not re-ask.
    expect(parseApprovalDecision("approve.")).toBe("approve");
    expect(parseApprovalDecision("yes!")).toBe("approve");
    expect(parseApprovalDecision("confirm!")).toBe("approve");
    expect(parseApprovalDecision("denied.")).toBe("deny");
    expect(parseApprovalDecision("no,")).toBe("deny");
  });
});

describe("approvalPrompt / constants (shared wording — both engines)", () => {
  it("uses the exact frozen-contract wording", () => {
    expect(approvalPrompt("github")).toBe('Approval required: run tool "github"? Reply "approve" or "deny".');
    expect(APPROVAL_DENIED_MESSAGE).toBe("Tool call was denied by the user.");
  });
});
