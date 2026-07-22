import { describe, expect, it, vi } from "vitest";
import {
  CompositeGithubIdentityResolver,
  GithubIdentityResolver,
  GithubTeamMembershipResolver,
  loadGithubIdentitiesFromEnv,
  loadTeamRolesFromEnv,
} from "./identity.js";

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

  it("resolves a known login", async () => {
    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("fails closed for an unknown login", async () => {
    await expect(resolver.resolve("mallory", false)).resolves.toBeUndefined();
  });

  it("fails closed for a Bot sender", async () => {
    await expect(resolver.resolve("some-other-bot", true)).resolves.toBeUndefined();
  });

  it("fails closed for the gateway's own bot login even if listed", async () => {
    await expect(resolver.resolve("agent-controller[bot]", false)).resolves.toBeUndefined();
  });
});

describe("loadTeamRolesFromEnv", () => {
  it("returns an empty map when unset", () => {
    expect(loadTeamRolesFromEnv(undefined).size).toBe(0);
  });

  it("returns an empty map on invalid JSON", () => {
    expect(loadTeamRolesFromEnv("not json").size).toBe(0);
  });

  it("parses a valid team-roles map", () => {
    const map = loadTeamRolesFromEnv(JSON.stringify({ "acme/writers": ["writer"] }));
    expect(map.get("acme/writers")).toEqual(["writer"]);
  });

  it("drops entries without a slash", () => {
    const map = loadTeamRolesFromEnv(JSON.stringify({ writers: ["writer"] }));
    expect(map.size).toBe(0);
  });

  it("drops entries whose value isn't a non-empty string array", () => {
    const map = loadTeamRolesFromEnv(JSON.stringify({ "acme/writers": "writer", "acme/empty": [] }));
    expect(map.size).toBe(0);
  });
});

describe("GithubTeamMembershipResolver", () => {
  const authConfig = {
    githubToken: "pat_123",
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppInstallationId: "",
    githubApiUrl: "https://api.github.com",
  };

  function makeResolver(fetchImpl: ReturnType<typeof vi.fn>, now = () => 0) {
    return new GithubTeamMembershipResolver({
      teamRoles: new Map([["acme/writers", ["writer"]]]),
      authConfig,
      githubApiUrl: "https://api.github.com",
      botLogin: "agent-controller[bot]",
      fetchImpl,
      now,
    });
  }

  it("resolves an active team member to the configured roles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: "active" }) });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["writer"] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/orgs/acme/teams/writers/memberships/alice",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer pat_123" }) }),
    );
  });

  it("fails closed for a 404 (not a member)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("mallory", false)).resolves.toBeUndefined();
  });

  it("fails closed for a pending (not yet accepted) membership", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: "pending" }) });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("bob", false)).resolves.toBeUndefined();
  });

  it("fails closed on an API error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("alice", false)).resolves.toBeUndefined();
  });

  it("fails closed for a Bot sender and the gateway's own bot login", async () => {
    const fetchImpl = vi.fn();
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("some-bot", true)).resolves.toBeUndefined();
    await expect(resolver.resolve("agent-controller[bot]", false)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches a positive result and does not re-check GitHub within the TTL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: "active" }) });
    let now = 0;
    const resolver = makeResolver(fetchImpl, () => now);

    await resolver.resolve("alice", false);
    now += 1000;
    await resolver.resolve("alice", false);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-checks GitHub after a negative result's (shorter) TTL expires", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    let now = 0;
    const resolver = makeResolver(fetchImpl, () => now);

    await resolver.resolve("alice", false);
    now += 61_000;
    await resolver.resolve("alice", false);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("CompositeGithubIdentityResolver", () => {
  it("prefers the primary resolver's identity", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["writer"] }) };
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver(primary, fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["writer"] });
  });

  it("falls back to the static resolver when the primary finds nothing", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue(undefined) };
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver(primary, fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("falls back to the static resolver when there is no primary configured", async () => {
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver(undefined, fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("fails closed when neither resolver grants an identity", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue(undefined) };
    const fallback = new GithubIdentityResolver(new Map(), "bot");
    const resolver = new CompositeGithubIdentityResolver(primary, fallback);

    await expect(resolver.resolve("mallory", false)).resolves.toBeUndefined();
  });
});
