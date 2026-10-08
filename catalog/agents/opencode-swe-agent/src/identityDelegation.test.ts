import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  finalizeDelegatedWrite,
  isDelegating,
  resolveDelegatedToken,
  resolveUndelegatedToken,
} from "./identityDelegation.js";
import type { AgentToolConfig } from "./config.js";

let privateKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKey = pair.privateKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseConfig(overrides: Partial<AgentToolConfig> = {}): AgentToolConfig {
  return {
    githubToken: "ghu_user",
    githubAppId: "1",
    githubAppPrivateKey: privateKey,
    githubAppInstallationId: "999",
    githubAppSlug: "my-app",
    identityDelegationEnabled: true,
    anthropicApiKey: "sk-ant",
    model: "anthropic/claude-sonnet-5",
    githubApiUrl: "https://api.github.com",
    workdir: "/tmp/swe",
    homeDir: "/tmp/home",
    targetRepository: "",
    ...overrides,
  };
}

/**
 * Stubs GitHub's installation-token endpoint and records the JSON body of each
 * mint (`repositories`/`permissions`), so a test can assert exactly how the
 * token was scoped. Mirrors claude-code-swe-agent's helper of the same name.
 */
async function withTokenEndpoint<T>(run: (mints: unknown[]) => Promise<T>): Promise<T> {
  const mints: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/access_tokens")) {
      mints.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(JSON.stringify({ token: "app-token", expires_at: new Date().toISOString() }), { status: 201 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  try {
    return await run(mints);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("isDelegating", () => {
  it("is true when the flag, App creds, and a user token are all present", () => {
    expect(isDelegating(baseConfig())).toBe(true);
  });

  it("is false when the flag is off", () => {
    expect(isDelegating(baseConfig({ identityDelegationEnabled: false }))).toBe(false);
  });

  it("is false when App creds are only partially configured", () => {
    expect(isDelegating(baseConfig({ githubAppInstallationId: "" }))).toBe(false);
  });

  it("is false when there is no user token", () => {
    expect(isDelegating(baseConfig({ githubToken: "" }))).toBe(false);
  });
});

describe("resolveDelegatedToken", () => {
  it("mints a repo-scoped token and returns attribution when repo is known", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "write" }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ token: "ghs_scoped", expires_at: "" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDelegatedToken(baseConfig(), "acme/widgets", false, 1_700_000_000_000);
    expect(result).toEqual({ token: "ghs_scoped", attribution: { githubLogin: "octocat", githubId: 42 } });
  });

  it("throws AuthorizationError before minting anything when repo is known but access is insufficient", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "read" }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveDelegatedToken(baseConfig(), "acme/widgets", false, 1_700_000_000_000)).rejects.toThrow(
      AuthorizationError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // never reached mintInstallationToken
  });

  it("mints an installation-wide token (no repo scoping) when repo is unknown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ token: "ghs_wide", expires_at: "" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDelegatedToken(baseConfig(), null, false, 1_700_000_000_000);
    expect(result).toEqual({ token: "ghs_wide", attribution: { githubLogin: "octocat", githubId: 42 } });
    const mintCall = fetchMock.mock.calls[1]!;
    expect(mintCall[1].body).toBeUndefined();
  });
});

// The non-delegating (webhook) credential path -- the DEFAULT review path,
// since the `ai-review` IntegrationRoutes dispatch to
// `agentRef: opencode-swe-agent`. A review run here must get a credential-layer
// read-only ceiling (contents:read), independent of the opencode deny list, so
// `gh api --method PUT/PATCH/POST` cannot mutate the repo.
describe("resolveUndelegatedToken", () => {
  const REVIEW_PERMS = { contents: "read", pull_requests: "write", issues: "write" };

  it("mints a read-only, repo-scoped token for a webhook review (reviewMode=true)", async () => {
    await withTokenEndpoint(async (mints) => {
      const token = await resolveUndelegatedToken(
        baseConfig({ githubToken: "", targetRepository: "acme/widgets" }),
        true,
        1_700_000_000_000,
      );
      expect(token).toBe("app-token");
      expect(mints).toEqual([{ repositories: ["widgets"], permissions: REVIEW_PERMS }]);
    });
  });

  it("does NOT narrow permissions on a non-review run (contents stays writable)", async () => {
    await withTokenEndpoint(async (mints) => {
      const token = await resolveUndelegatedToken(
        baseConfig({ githubToken: "", targetRepository: "acme/widgets" }),
        false,
        1_700_000_000_000,
      );
      expect(token).toBe("app-token");
      // Repo-scoped, but the installation's default permission set -- no
      // `permissions` key, exactly as a change run has always been minted.
      expect(mints).toEqual([{ repositories: ["widgets"] }]);
    });
  });
});

describe("finalizeDelegatedWrite", () => {
  const attribution = { githubLogin: "octocat", githubId: 42 };

  it("grants collaborator access when the repo was created during this turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ created_at: "2024-01-01T00:00:10.000Z" }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    const outcome = await finalizeDelegatedWrite({
      token: "ghs_wide",
      attribution,
      repo: "acme/new-repo",
      githubApiUrl: "https://api.github.com",
      turnStartedAt: new Date("2024-01-01T00:00:00.000Z").getTime(),
      fetchImpl: fetchMock,
    });

    expect(outcome).toEqual({ kind: "granted" });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.github.com/repos/acme/new-repo/collaborators/octocat");
  });

  it("verifies (no grant) when the repo pre-existed and the user has write access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ created_at: "2020-01-01T00:00:00.000Z" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "admin" }) });

    const outcome = await finalizeDelegatedWrite({
      token: "ghs_wide",
      attribution,
      repo: "acme/existing-repo",
      githubApiUrl: "https://api.github.com",
      turnStartedAt: new Date("2024-01-01T00:00:00.000Z").getTime(),
      fetchImpl: fetchMock,
    });

    expect(outcome).toEqual({ kind: "verified" });
  });

  it("flags a revoke when the repo pre-existed and the user lacks write access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ created_at: "2020-01-01T00:00:00.000Z" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "read" }) });

    const outcome = await finalizeDelegatedWrite({
      token: "ghs_wide",
      attribution,
      repo: "acme/existing-repo",
      githubApiUrl: "https://api.github.com",
      turnStartedAt: new Date("2024-01-01T00:00:00.000Z").getTime(),
      fetchImpl: fetchMock,
    });

    expect(outcome.kind).toBe("revoke");
  });
});
