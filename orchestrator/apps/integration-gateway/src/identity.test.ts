import { describe, expect, it, vi } from "vitest";
import {
  CompositeGithubIdentityResolver,
  GithubCollaboratorPermissionResolver,
  GithubIdentityResolver,
  GithubTeamMembershipResolver,
  loadGithubIdentitiesFromEnv,
  loadPermissionRolesFromEnv,
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

describe("loadPermissionRolesFromEnv", () => {
  it("returns an empty map when unset", () => {
    expect(loadPermissionRolesFromEnv(undefined).size).toBe(0);
  });

  it("returns an empty map on invalid JSON", () => {
    expect(loadPermissionRolesFromEnv("not json").size).toBe(0);
  });

  it("parses a valid permission-roles map", () => {
    const map = loadPermissionRolesFromEnv(JSON.stringify({ admin: ["writer"], write: ["writer"] }));
    expect(map.get("admin")).toEqual(["writer"]);
    expect(map.get("write")).toEqual(["writer"]);
  });

  it("drops entries whose value isn't a non-empty string array", () => {
    const map = loadPermissionRolesFromEnv(JSON.stringify({ admin: "writer", read: [] }));
    expect(map.size).toBe(0);
  });
});

describe("GithubCollaboratorPermissionResolver", () => {
  const authConfig = {
    githubToken: "pat_123",
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppInstallationId: "",
    githubApiUrl: "https://api.github.com",
  };
  const repoContext = { owner: "acme", repo: "widgets" };

  function makeResolver(fetchImpl: ReturnType<typeof vi.fn>, now = () => 0) {
    return new GithubCollaboratorPermissionResolver({
      permissionRoles: new Map([
        ["admin", ["writer"]],
        ["write", ["writer"]],
      ]),
      authConfig,
      githubApiUrl: "https://api.github.com",
      botLogin: "agent-controller[bot]",
      fetchImpl,
      now,
    });
  }

  it("resolves a collaborator with a configured permission level to the granted roles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ permission: "write" }) });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("alice", false, repoContext)).resolves.toEqual({ subject: "alice", roles: ["writer"] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/collaborators/alice/permission",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer pat_123" }) }),
    );
  });

  it("fails closed for a permission level not in the configured map", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ permission: "read" }) });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("bob", false, repoContext)).resolves.toBeUndefined();
  });

  it("fails closed for a 404 (not a collaborator)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("mallory", false, repoContext)).resolves.toBeUndefined();
  });

  it("fails closed on an API error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("alice", false, repoContext)).resolves.toBeUndefined();
  });

  it("fails closed when no repo context is provided", async () => {
    const fetchImpl = vi.fn();
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("alice", false)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed for a Bot sender and the gateway's own bot login", async () => {
    const fetchImpl = vi.fn();
    const resolver = makeResolver(fetchImpl);

    await expect(resolver.resolve("some-bot", true, repoContext)).resolves.toBeUndefined();
    await expect(resolver.resolve("agent-controller[bot]", false, repoContext)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches a positive result per owner/repo/login and does not re-check GitHub within the TTL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ permission: "admin" }) });
    let now = 0;
    const resolver = makeResolver(fetchImpl, () => now);

    await resolver.resolve("alice", false, repoContext);
    now += 1000;
    await resolver.resolve("alice", false, repoContext);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks separately for the same login on a different repo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ permission: "admin" }) });
    const resolver = makeResolver(fetchImpl);

    await resolver.resolve("alice", false, repoContext);
    await resolver.resolve("alice", false, { owner: "acme", repo: "other-repo" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("CompositeGithubIdentityResolver", () => {
  it("prefers the first primary resolver's identity", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["writer"] }) };
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver([primary], fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["writer"] });
  });

  it("falls through to a later primary when an earlier one finds nothing", async () => {
    const first = { resolve: vi.fn().mockResolvedValue(undefined) };
    const second = { resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["writer"] }) };
    const fallback = new GithubIdentityResolver(new Map(), "bot");
    const resolver = new CompositeGithubIdentityResolver([first, second], fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["writer"] });
  });

  it("falls back to the static resolver when no primary finds anything", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue(undefined) };
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver([primary], fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("falls back to the static resolver when there are no primaries configured", async () => {
    const fallback = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "bot");
    const resolver = new CompositeGithubIdentityResolver([undefined], fallback);

    await expect(resolver.resolve("alice", false)).resolves.toEqual({ subject: "alice", roles: ["reporter"] });
  });

  it("passes the repo context through to primary resolvers", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["writer"] }) };
    const fallback = new GithubIdentityResolver(new Map(), "bot");
    const resolver = new CompositeGithubIdentityResolver([primary], fallback);

    await resolver.resolve("alice", false, { owner: "acme", repo: "widgets" });
    expect(primary.resolve).toHaveBeenCalledWith("alice", false, { owner: "acme", repo: "widgets" });
  });

  it("fails closed when neither resolver grants an identity", async () => {
    const primary = { resolve: vi.fn().mockResolvedValue(undefined) };
    const fallback = new GithubIdentityResolver(new Map(), "bot");
    const resolver = new CompositeGithubIdentityResolver([primary], fallback);

    await expect(resolver.resolve("mallory", false)).resolves.toBeUndefined();
  });
});
