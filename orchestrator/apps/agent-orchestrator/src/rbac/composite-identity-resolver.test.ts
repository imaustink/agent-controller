import { describe, expect, it } from "vitest";
import { CompositeIdentityResolver } from "./composite-identity-resolver.js";
import { StaticIdentityResolver } from "./static-identity-resolver.js";
import type { Identity, IdentityResolver } from "./types.js";

class StubResolver implements IdentityResolver {
  constructor(private readonly identity: Identity | undefined) {}
  async resolve(): Promise<Identity | undefined> {
    return this.identity;
  }
}

describe("CompositeIdentityResolver", () => {
  it("resolves via the primary resolver when it succeeds", async () => {
    const primary = new StubResolver({ subject: "alice", roles: ["reader"] });
    const fallback = new StubResolver({ subject: "should-not-be-used", roles: [] });
    const resolver = new CompositeIdentityResolver(primary, fallback);
    await expect(resolver.resolve("tok")).resolves.toEqual({ subject: "alice", roles: ["reader"] });
  });

  it("falls back when the primary resolver fails to resolve the token", async () => {
    const primary = new StaticIdentityResolver(new Map()); // never resolves anything
    const fallback = new StaticIdentityResolver(new Map([["tok-1", { subject: "openwebui", roles: ["reader", "writer"] }]]));
    const resolver = new CompositeIdentityResolver(primary, fallback);
    await expect(resolver.resolve("tok-1")).resolves.toEqual({ subject: "openwebui", roles: ["reader", "writer"] });
  });

  it("fails closed when neither resolver resolves the token", async () => {
    const resolver = new CompositeIdentityResolver(new StaticIdentityResolver(new Map()), new StaticIdentityResolver(new Map()));
    await expect(resolver.resolve("nope")).resolves.toBeUndefined();
  });
});
