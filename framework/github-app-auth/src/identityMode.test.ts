import { describe, expect, it } from "vitest";
import { IdentityModeError, readsAsCaller, resolveIdentityMode } from "./identityMode.js";

describe("resolveIdentityMode", () => {
  it("honours a declared mode exactly", () => {
    expect(resolveIdentityMode({ declared: "agent", githubToken: "gho_x", hasAppCredentials: true })).toBe("agent");
    expect(resolveIdentityMode({ declared: "delegated", githubToken: "gho_x", hasAppCredentials: false })).toBe("delegated");
    expect(resolveIdentityMode({ declared: "hybrid", githubToken: "gho_x", hasAppCredentials: true })).toBe("hybrid");
  });

  it("refuses a caller mode with no caller token rather than falling back to the App", () => {
    for (const declared of ["delegated", "hybrid"]) {
      expect(() => resolveIdentityMode({ declared, hasAppCredentials: true })).toThrow(IdentityModeError);
      expect(() => resolveIdentityMode({ declared, hasAppCredentials: true })).toThrow(/wider credential/);
    }
  });

  it("refuses hybrid with no App to write as", () => {
    expect(() => resolveIdentityMode({ declared: "hybrid", githubToken: "gho_x", hasAppCredentials: false })).toThrow(
      /no GitHub App configuration/,
    );
  });

  it("refuses an unknown mode", () => {
    expect(() => resolveIdentityMode({ declared: "user", githubToken: "gho_x", hasAppCredentials: true })).toThrow(
      /not one of agent, delegated, hybrid/,
    );
  });

  // A run no pre-flight decided keeps the pre-0049 inference.
  it("infers hybrid from a caller token plus App credentials when undeclared", () => {
    expect(resolveIdentityMode({ githubToken: "gho_x", hasAppCredentials: true })).toBe("hybrid");
    expect(resolveIdentityMode({ declared: "  ", githubToken: "gho_x", hasAppCredentials: true })).toBe("hybrid");
  });

  it("infers agent otherwise", () => {
    expect(resolveIdentityMode({ githubToken: "ghp_static", hasAppCredentials: false })).toBe("agent");
    expect(resolveIdentityMode({ hasAppCredentials: true })).toBe("agent");
    expect(resolveIdentityMode({ hasAppCredentials: false })).toBe("agent");
  });
});

describe("readsAsCaller", () => {
  it("is true only for the caller modes", () => {
    expect(readsAsCaller("delegated")).toBe(true);
    expect(readsAsCaller("hybrid")).toBe(true);
    expect(readsAsCaller("agent")).toBe(false);
  });
});
