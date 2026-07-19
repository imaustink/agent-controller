import { describe, expect, it } from "vitest";
import { GithubIdentityResolver, loadGithubIdentitiesFromEnv } from "./identity.js";

describe("loadGithubIdentitiesFromEnv", () => {
  it("returns an empty map when unset", () => {
    expect(loadGithubIdentitiesFromEnv(undefined).size).toBe(0);
  });

  it("returns an empty map on invalid JSON", () => {
    expect(loadGithubIdentitiesFromEnv("not json").size).toBe(0);
  });

  it("parses a valid identities map", () => {
    const map = loadGithubIdentitiesFromEnv(
      JSON.stringify({ alice: { subject: "alice", roles: ["reporter"] } }),
    );
    expect(map.get("alice")).toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("drops malformed entries", () => {
    const map = loadGithubIdentitiesFromEnv(JSON.stringify({ alice: { subject: "alice" }, bob: "not-an-object" }));
    expect(map.size).toBe(0);
  });
});

describe("GithubIdentityResolver", () => {
  const identities = new Map([["alice", { subject: "alice", roles: ["reporter"] }]]);
  const resolver = new GithubIdentityResolver(identities, "agent-controller[bot]");

  it("resolves a known login", () => {
    expect(resolver.resolve("alice", false)).toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("fails closed for an unknown login", () => {
    expect(resolver.resolve("mallory", false)).toBeUndefined();
  });

  it("fails closed for a Bot sender", () => {
    expect(resolver.resolve("some-other-bot", true)).toBeUndefined();
  });

  it("fails closed for the gateway's own bot login even if listed", () => {
    expect(resolver.resolve("agent-controller[bot]", false)).toBeUndefined();
  });
});
