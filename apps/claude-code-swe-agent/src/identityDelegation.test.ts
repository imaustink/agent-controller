import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupGitAuth } from "./git.js";
import { isDelegating, resolveDelegatedToken, resolveUndelegatedToken } from "./identityDelegation.js";
import type { AgentToolConfig } from "./config.js";

const IDENTITY = { name: "agent[bot]", email: "1+agent[bot]@users.noreply.github.com" };

async function gitconfigFor(opts: { token: string; pushToken?: string }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "gitauth-"));
  await setupGitAuth({ homeDir: home, apiHost: "github.com", identity: IDENTITY, ...opts });
  return readFile(join(home, ".gitconfig"), "utf8");
}

describe("setupGitAuth credential split", () => {
  // git resolves pushInsteadOf for push URLs and insteadOf for everything
  // else, so this is the whole read/write split for git -- no wrapper.
  it("sends fetches to the read token and pushes to the write token", async () => {
    const config = await gitconfigFor({ token: "user-token", pushToken: "app-token" });
    expect(config).toContain('[url "https://x-access-token:user-token@github.com/"]');
    expect(config).toContain("\tinsteadOf = https://github.com/");
    expect(config).toContain('[url "https://x-access-token:app-token@github.com/"]');
    expect(config).toContain("\tpushInsteadOf = https://github.com/");
  });

  it("emits no push rewrite at all when not delegating, leaving prior behaviour untouched", async () => {
    expect(await gitconfigFor({ token: "only-token" })).not.toContain("pushInsteadOf");
    expect(await gitconfigFor({ token: "same", pushToken: "same" })).not.toContain("pushInsteadOf");
  });
});

// A real key: mintInstallationToken signs an RS256 App JWT with it, so a
// placeholder string fails inside node:crypto before any fetch happens.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function config(over: Partial<AgentToolConfig> = {}): AgentToolConfig {
  return {
    identityDelegationEnabled: true,
    githubToken: "user-token",
    githubAppId: "1",
    githubAppPrivateKey: privateKey,
    githubAppInstallationId: "2",
    githubApiUrl: "https://api.github.com",
    actorLogin: "alice",
    ...over,
  } as AgentToolConfig;
}

describe("isDelegating", () => {
  // The gate that kept this whole path dead: without a per-user GITHUB_TOKEN
  // (i.e. without `github` in the Agent's identityProviders) every run fell
  // back to the plain installation token for reads AND writes.
  it("requires app credentials, the feature flag, and a per-user token", () => {
    expect(isDelegating(config())).toBe(true);
    expect(isDelegating(config({ githubToken: "" }))).toBe(false);
    expect(isDelegating(config({ identityDelegationEnabled: false }))).toBe(false);
    expect(isDelegating(config({ githubAppPrivateKey: "" }))).toBe(false);
  });
});

describe("resolveDelegatedToken", () => {
  it("returns the user's token for reads and a minted App token for writes", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "app-token", expires_at: new Date().toISOString() }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    try {
      // No repo known yet: the fresh-task path, which mints installation-wide.
      const resolved = await resolveDelegatedToken(config(), null);
      expect(resolved.readToken).toBe("user-token");
      expect(resolved.writeToken).toBe("app-token");
      expect(resolved.attribution.githubLogin).toBe("alice");
      // actorLogin was supplied, so the /user lookup -- the call that 401'd in
      // production and got this provider excluded -- must not happen.
      expect(calls.some((c) => c.endsWith("/user"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Stubs GitHub for the App's token endpoint, recording each mint's body so a
 * spec can see which repositories a token was scoped to.
 */
async function withTokenEndpoint<T>(run: (mints: unknown[], calls: string[]) => Promise<T>): Promise<T> {
  const mints: unknown[] = [];
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/access_tokens")) {
      mints.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(JSON.stringify({ token: "app-token", expires_at: new Date().toISOString() }), { status: 201 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  try {
    return await run(mints, calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The orchestrator's read gate checked ONE repository before launching. The
// App token must be scoped to exactly that one, or "the App writes" would
// mean "the App writes anywhere it is installed".
describe("a verified target repository", () => {
  it("scopes a delegating run's write token to it, with reads still on the user's token", async () => {
    await withTokenEndpoint(async (mints, calls) => {
      const resolved = await resolveDelegatedToken(config({ targetRepository: "bitovi/platform" }), null);
      expect(resolved.readToken).toBe("user-token");
      expect(resolved.writeToken).toBe("app-token");
      expect(mints).toEqual([{ repositories: ["platform"] }]);
      // No write-permission check: reads were what the gate verified, and
      // writes are the App's by design.
      expect(calls.some((c) => c.includes("/collaborators/"))).toBe(false);
    });
  });

  it("scopes a webhook run's only token to it", async () => {
    await withTokenEndpoint(async (mints) => {
      const token = await resolveUndelegatedToken(config({ githubToken: "", targetRepository: "e2e-org/e2e-repo" }));
      expect(token).toBe("app-token");
      expect(mints).toEqual([{ repositories: ["e2e-repo"] }]);
    });
  });

  it("leaves a run with no target repository on the installation-wide token, as before", async () => {
    await withTokenEndpoint(async (mints) => {
      await resolveUndelegatedToken(config({ githubToken: "", targetRepository: "" }));
      expect(mints).toEqual([{}]);
    });
  });
});
