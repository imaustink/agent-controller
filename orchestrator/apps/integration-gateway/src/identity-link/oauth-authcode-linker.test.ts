import { describe, expect, it, vi } from "vitest";
import { OAuthAuthCodeLinker } from "./oauth-authcode-linker.js";
import { loadOAuthProviders } from "./providers.js";
import type { IdentityLinkStore, LinkedCredential } from "./store.js";

const STATE_SECRET = "state-secret";
const NOW = Date.parse("2026-09-19T12:00:00Z");

function atlassian() {
  return loadOAuthProviders({
    ATLASSIAN_CLIENT_ID: "atl-client",
    ATLASSIAN_CLIENT_SECRET: "atl-secret",
  } as NodeJS.ProcessEnv).get("atlassian")!;
}

/** In-memory store that can be made to fail its write. */
class FakeStore implements IdentityLinkStore {
  readonly records = new Map<string, LinkedCredential>();
  failWrites = false;

  async get(provider: string, subject: string) {
    return this.records.get(`${provider}/${subject}`);
  }
  async set(provider: string, subject: string, cred: LinkedCredential) {
    if (this.failWrites) throw new Error("secret write failed");
    this.records.set(`${provider}/${subject}`, cred);
  }
  async waitForCompletion() {
    return undefined;
  }
  async delete(provider: string, subject: string) {
    this.records.delete(`${provider}/${subject}`);
  }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function linkerWith(fetchImpl: typeof fetch, store = new FakeStore()) {
  return {
    store,
    linker: new OAuthAuthCodeLinker({
      config: atlassian(),
      store,
      stateSecret: STATE_SECRET,
      redirectUri: "https://gw.example/identity-link/atlassian/callback",
      fetchImpl,
      now: () => NOW,
    }),
  };
}

describe("startAuthCode", () => {
  it("builds an authorize URL carrying the configured scopes and a signed state", () => {
    const { linker } = linkerWith(vi.fn());
    const { authorizeUrl } = linker.startAuthCode("openwebui:42");
    const url = new URL(authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("atl-client");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("forces consent, without which no refresh token is issued", () => {
    const { linker } = linkerWith(vi.fn());
    const url = new URL(linker.startAuthCode("s").authorizeUrl);
    // A re-link without this silently yields an access token that dies in an
    // hour with no way to renew it.
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("carries the provider's required audience, without which Atlassian rejects the request", () => {
    const { linker } = linkerWith(vi.fn());
    const url = new URL(linker.startAuthCode("s").authorizeUrl);
    // auth.atlassian.com/authorize 400s without audience=api.atlassian.com,
    // so the link this PR exists to enable could never complete.
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
  });
});

describe("completeAuthCode", () => {
  it("stores the credential and records the account id", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ account_id: "acc-123" }));

    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("openwebui:42").authorizeUrl).searchParams.get("state")!;

    const result = await linker.completeAuthCode(state, "the-code");

    expect(result).toEqual({ subject: "openwebui:42" });
    const stored = await store.get("atlassian", "openwebui:42");
    expect(stored?.token).toBe("at-1");
    expect(stored?.refreshToken).toBe("rt-1");
    expect(stored?.accountId).toBe("acc-123");
    // Subjects are never re-keyed on a provider account id (ADR 0029).
    expect(store.records.has("atlassian/openwebui:42")).toBe(true);
  });

  it("rejects a state this linker did not sign", async () => {
    const { linker } = linkerWith(vi.fn());
    expect(await linker.completeAuthCode("not-a-real-state", "code")).toBeUndefined();
  });

  it("returns undefined rather than throwing when the provider rejects the code", async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse({}, false, 400));
    const { linker } = linkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("s").authorizeUrl).searchParams.get("state")!;

    // Routine callback abuse and expiry, not a bug.
    expect(await linker.completeAuthCode(state, "used-already")).toBeUndefined();
  });

  it("still links when the account-id lookup fails", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }))
      .mockRejectedValueOnce(new Error("me endpoint down"));

    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("s").authorizeUrl).searchParams.get("state")!;

    expect(await linker.completeAuthCode(state, "code")).toEqual({ subject: "s" });
    // Provenance is nice to have; the link is not.
    expect((await store.get("atlassian", "s"))?.accountId).toBeUndefined();
  });
});

describe("getValidToken", () => {
  const linked = (overrides: Partial<LinkedCredential> = {}): LinkedCredential => ({
    githubLogin: "",
    accountId: "acc-1",
    token: "at-old",
    expiresAt: new Date(NOW + 3600_000).toISOString(),
    refreshToken: "rt-old",
    refreshExpiresAt: undefined,
    ...overrides,
  });

  it("returns undefined when nothing is linked", async () => {
    const { linker } = linkerWith(vi.fn());
    expect(await linker.getValidToken("nobody")).toBeUndefined();
  });

  it("returns a still-fresh token without calling the provider", async () => {
    const http = vi.fn();
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    await store.set("atlassian", "s", linked());

    expect(await linker.getValidToken("s")).toEqual({ token: "at-old" });
    expect(http).not.toHaveBeenCalled();
  });

  it("refreshes a token inside the expiry skew", async () => {
    const http = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }));
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    // Expires in 30s — usable now, dead mid-request.
    await store.set("atlassian", "s", linked({ expiresAt: new Date(NOW + 30_000).toISOString() }));

    expect(await linker.getValidToken("s")).toEqual({ token: "at-new" });
  });

  it("persists the ROTATED refresh token, since the old one is now dead", async () => {
    const http = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }));
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    await store.set("atlassian", "s", linked({ expiresAt: new Date(NOW - 1000).toISOString() }));

    await linker.getValidToken("s");

    const stored = await store.get("atlassian", "s");
    // Storing the spent token instead is exactly what produced the
    // claude-remote re-authorization loop.
    expect(stored?.refreshToken).toBe("rt-new");
    expect(stored?.token).toBe("at-new");
    expect(stored?.accountId).toBe("acc-1");
  });

  it("backfills a missing accountId on refresh", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ account_id: "acc-backfilled" }));
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    await store.set("atlassian", "s", linked({ accountId: undefined, expiresAt: new Date(NOW - 1000).toISOString() }));

    await linker.getValidToken("s");

    expect((await store.get("atlassian", "s"))?.accountId).toBe("acc-backfilled");
  });

  it("still returns the working token when persistence fails, and says so loudly", async () => {
    const http = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }));
    const store = new FakeStore();
    const { linker } = linkerWith(http as unknown as typeof fetch, store);
    await store.set("atlassian", "s", linked({ expiresAt: new Date(NOW - 1000).toISOString() }));
    store.failWrites = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // The old refresh token is already spent, so failing quietly would strand
    // the link with no signal.
    expect(await linker.getValidToken("s")).toEqual({ token: "at-new" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"), expect.anything());
    logged.mockRestore();
  });

  it("leaves the stored credential untouched when a refresh fails", async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    await store.set("atlassian", "s", linked({ expiresAt: new Date(NOW - 1000).toISOString() }));

    expect(await linker.getValidToken("s")).toBeUndefined();
    // A refresh we did not complete costs one request, not the link.
    expect((await store.get("atlassian", "s"))?.refreshToken).toBe("rt-old");
  });

  it("gives up when an expired credential has no refresh token", async () => {
    const { linker, store } = linkerWith(vi.fn());
    await store.set(
      "atlassian",
      "s",
      linked({ expiresAt: new Date(NOW - 1000).toISOString(), refreshToken: undefined }),
    );

    expect(await linker.getValidToken("s")).toBeUndefined();
  });

  it("treats a missing expires_in as already expired rather than eternal", async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse({ access_token: "at", refresh_token: "rt" }));
    const { linker, store } = linkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("s").authorizeUrl).searchParams.get("state")!;
    await linker.completeAuthCode(state, "code");

    const stored = await store.get("atlassian", "s");
    expect(Date.parse(stored!.expiresAt)).toBeLessThanOrEqual(NOW);
  });
});

describe("Slack's non-standard OAuth shape", () => {
  function slack() {
    return loadOAuthProviders({
      SLACK_CLIENT_ID: "slk-client",
      SLACK_CLIENT_SECRET: "slk-secret",
    } as NodeJS.ProcessEnv).get("slack")!;
  }

  function slackLinkerWith(fetchImpl: typeof fetch, store = new FakeStore()) {
    return {
      store,
      linker: new OAuthAuthCodeLinker({
        config: slack(),
        store,
        stateSecret: STATE_SECRET,
        redirectUri: "https://gw.example/identity-link/slack/callback",
        fetchImpl,
        now: () => NOW,
      }),
    };
  }

  it("requests the user scope through user_scope, not scope", () => {
    const { linker } = slackLinkerWith(vi.fn());
    const url = new URL(linker.startAuthCode("openwebui:42").authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    // search:read is a USER scope; sent as `scope` Slack rejects it as a bot scope.
    expect(url.searchParams.get("user_scope")).toBe("search:read");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("form-encodes the exchange and stores the user token from authed_user", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, access_token: "xoxb-bot", authed_user: { access_token: "xoxp-user" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, user_id: "U123" }));
    const { linker, store } = slackLinkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("openwebui:42").authorizeUrl).searchParams.get("state")!;

    const result = await linker.completeAuthCode(state, "the-code");

    expect(result).toEqual({ subject: "openwebui:42" });
    const [, init] = http.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    const stored = await store.get("slack", "openwebui:42");
    // The USER token, never the bot token that sits at the top level.
    expect(stored?.token).toBe("xoxp-user");
    expect(stored?.accountId).toBe("U123");
  });

  it("treats ok:false at HTTP 200 as a failed exchange, not an empty token", async () => {
    const http = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "invalid_code" }));
    const { linker } = slackLinkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("s").authorizeUrl).searchParams.get("state")!;

    // Slack returns HTTP 200 on failure; reading it as a success would store an
    // empty token and look like a broken feature.
    expect(await linker.completeAuthCode(state, "bad")).toBeUndefined();
  });

  it("keeps a non-expiring user token fresh instead of re-prompting every turn", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authed_user: { access_token: "xoxp-user" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, user_id: "U1" }));
    const { linker, store } = slackLinkerWith(http as unknown as typeof fetch);
    const state = new URL(linker.startAuthCode("s").authorizeUrl).searchParams.get("state")!;
    await linker.completeAuthCode(state, "code");

    // Slack sends no expires_in for a default user token, but it does not expire;
    // treating a missing expiry as stale is what would re-prompt on every turn.
    expect(await linker.getValidToken("s")).toEqual({ token: "xoxp-user" });
    expect(Date.parse((await store.get("slack", "s"))!.expiresAt)).toBeGreaterThan(NOW);
  });
});

describe("construction", () => {
  it("refuses a device-flow provider", () => {
    const github = loadOAuthProviders({ GITHUB_OAUTH_CLIENT_ID: "gh" } as NodeJS.ProcessEnv).get("github")!;
    expect(
      () =>
        new OAuthAuthCodeLinker({
          config: github,
          store: new FakeStore(),
          stateSecret: STATE_SECRET,
          redirectUri: "https://gw.example/cb",
        }),
    ).toThrow(/not an authorization-code provider/);
  });
});
