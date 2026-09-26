import { describe, expect, it } from "vitest";
import { loadOAuthProviders } from "./providers.js";

const githubEnv = { GITHUB_OAUTH_CLIENT_ID: "gh-client" } as NodeJS.ProcessEnv;
const atlassianEnv = {
  ATLASSIAN_CLIENT_ID: "atl-client",
  ATLASSIAN_CLIENT_SECRET: "atl-secret",
} as NodeJS.ProcessEnv;

describe("loadOAuthProviders", () => {
  it("registers nothing when nothing is configured", () => {
    // An unconfigured provider 400s at the route the way an unknown one always
    // has, rather than failing deep inside a token exchange.
    expect(loadOAuthProviders({} as NodeJS.ProcessEnv).size).toBe(0);
  });

  it("keeps github on the device flow", () => {
    const github = loadOAuthProviders(githubEnv).get("github");
    expect(github?.kind).toBe("device");
    expect(github?.clientSecret).toBeUndefined();
    expect(github?.rotatesRefreshToken).toBe(false);
  });

  it("registers atlassian as an authcode provider that rotates", () => {
    const atlassian = loadOAuthProviders(atlassianEnv).get("atlassian");
    expect(atlassian?.kind).toBe("authcode");
    expect(atlassian?.clientSecret).toBe("atl-secret");
    // Load-bearing: a rotating provider's old refresh token dies the instant
    // new tokens are issued, which is what produced the claude-remote re-auth
    // loop when a write-back was missed.
    expect(atlassian?.rotatesRefreshToken).toBe(true);
  });

  it("requires the audience Atlassian 3LO rejects the authorize request without", () => {
    const atlassian = loadOAuthProviders(atlassianEnv).get("atlassian");
    expect(atlassian?.authorizeParams).toEqual({ audience: "api.atlassian.com" });
  });

  it("does not register atlassian with only half its credentials", () => {
    const partial = loadOAuthProviders({
      ATLASSIAN_CLIENT_ID: "atl-client",
    } as NodeJS.ProcessEnv);
    expect(partial.has("atlassian")).toBe(false);
  });

  it("asks for search:confluence by default, which the read scopes do not imply", () => {
    // A token with the read scopes but not this one reads pages perfectly well
    // and fails every live lookup — a missing permission that presents as a
    // broken feature.
    const atlassian = loadOAuthProviders(atlassianEnv).get("atlassian");

    expect(atlassian?.scopes).toContain("search:confluence");
    expect(atlassian?.scopes).toContain("read:page:confluence");
  });

  it("forces offline_access on, since without it no refresh token is issued at all", () => {
    const atlassian = loadOAuthProviders({
      ...atlassianEnv,
      ATLASSIAN_SCOPES: "read:confluence-content.all",
    }).get("atlassian");

    expect(atlassian?.scopes).toContain("offline_access");
  });

  it("does not duplicate offline_access when it was already requested", () => {
    const atlassian = loadOAuthProviders({
      ...atlassianEnv,
      ATLASSIAN_SCOPES: "read:confluence-content.all offline_access",
    }).get("atlassian");

    expect(atlassian?.scopes.filter((s) => s === "offline_access")).toHaveLength(1);
  });

  it("accepts scopes separated by spaces or commas", () => {
    const spaced = loadOAuthProviders({
      ...atlassianEnv,
      ATLASSIAN_SCOPES: "a b",
    }).get("atlassian");
    const commas = loadOAuthProviders({
      ...atlassianEnv,
      ATLASSIAN_SCOPES: "a,b",
    }).get("atlassian");

    expect(spaced?.scopes).toEqual(["a", "b", "offline_access"]);
    expect(commas?.scopes).toEqual(["a", "b", "offline_access"]);
  });

  it("registers both providers side by side", () => {
    const registry = loadOAuthProviders({ ...githubEnv, ...atlassianEnv });
    expect([...registry.keys()].sort()).toEqual(["atlassian", "github"]);
  });
});
