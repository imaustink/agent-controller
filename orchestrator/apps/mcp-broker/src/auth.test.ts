import { describe, expect, it } from "vitest";
import { authenticate, secretsMatch, UnauthorizedError, type AuthConfig } from "./auth.js";

const config: AuthConfig = { orchestratorToken: "orchestrator-secret" };

describe("authenticate", () => {
  it("accepts the orchestrator token", () => {
    expect(() => authenticate(config, "Bearer orchestrator-secret")).not.toThrow();
  });

  it("tolerates whitespace and a case-insensitive scheme", () => {
    expect(() => authenticate(config, "bearer   orchestrator-secret  ")).not.toThrow();
  });

  it("fails closed on a missing, empty or unknown token", () => {
    // An unrecognized caller is never an anonymous one with reduced powers —
    // every accepted caller may cause a tools/call to run.
    expect(() => authenticate(config, undefined)).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "")).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "Bearer ")).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "Bearer nope")).toThrow(UnauthorizedError);
  });

  it("does not accept a correct prefix", () => {
    // A timing-safe compare must also be a length-safe one: a prefix of the
    // secret is not the secret.
    expect(() => authenticate(config, "Bearer orchestrator-secre")).toThrow(UnauthorizedError);
    expect(() => authenticate(config, "Bearer orchestrator-secretX")).toThrow(UnauthorizedError);
  });
});

describe("secretsMatch", () => {
  it("is true only for an exact match", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    // Differing lengths must return false rather than throw (the timingSafeEqual
    // underneath requires equal-length buffers).
    expect(secretsMatch("abc", "abcd")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
  });
});
