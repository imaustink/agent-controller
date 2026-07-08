import { describe, expect, it } from "vitest";
import { StaticIdentityResolver, loadStaticIdentitiesFromEnv } from "./static-identity-resolver.js";

describe("loadStaticIdentitiesFromEnv", () => {
  it("returns an empty map for missing/invalid input (fail closed)", () => {
    expect(loadStaticIdentitiesFromEnv(undefined).size).toBe(0);
    expect(loadStaticIdentitiesFromEnv("not json").size).toBe(0);
    expect(loadStaticIdentitiesFromEnv("[]").size).toBe(0);
  });

  it("parses a valid token -> identity map", () => {
    const map = loadStaticIdentitiesFromEnv(
      JSON.stringify({ "tok-1": { subject: "alice", roles: ["reader"] } }),
    );
    expect(map.get("tok-1")).toEqual({ subject: "alice", roles: ["reader"] });
  });

  it("skips malformed entries", () => {
    const map = loadStaticIdentitiesFromEnv(
      JSON.stringify({ "tok-1": { subject: "alice" }, "tok-2": { subject: "bob", roles: ["x"] } }),
    );
    expect(map.has("tok-1")).toBe(false);
    expect(map.get("tok-2")).toEqual({ subject: "bob", roles: ["x"] });
  });
});

describe("StaticIdentityResolver", () => {
  it("resolves a known token", async () => {
    const resolver = new StaticIdentityResolver(new Map([["tok-1", { subject: "alice", roles: ["reader"] }]]));
    await expect(resolver.resolve("tok-1")).resolves.toEqual({ subject: "alice", roles: ["reader"] });
  });

  it("fails closed for an unknown token", async () => {
    const resolver = new StaticIdentityResolver(new Map());
    await expect(resolver.resolve("nope")).resolves.toBeUndefined();
  });
});
