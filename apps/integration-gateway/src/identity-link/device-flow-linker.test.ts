import { afterEach, describe, expect, it, vi } from "vitest";
import * as deviceFlow from "@controller-agent/github-app-auth";
import { GithubDeviceFlowLinker } from "./device-flow-linker.js";
import type { IdentityLinkStore, LinkedCredential } from "./store.js";

function makeInMemoryStore(): IdentityLinkStore & { data: Map<string, LinkedCredential> } {
  const data = new Map<string, LinkedCredential>();
  return {
    data,
    async get(provider, subject) {
      return data.get(`${provider}:${subject}`);
    },
    async set(provider, subject, cred) {
      data.set(`${provider}:${subject}`, cred);
    },
  };
}

function makeFetchMock(login: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ login }),
    text: async () => "",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GithubDeviceFlowLinker.start", () => {
  it("passes through startDeviceFlow's result", async () => {
    vi.spyOn(deviceFlow, "startDeviceFlow").mockResolvedValue({
      deviceCode: "dc-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: "repo", store });

    const result = await linker.start("user-1");

    expect(result).toEqual({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
      deviceCode: "dc-1",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
  });
});

describe("GithubDeviceFlowLinker.poll", () => {
  it("returns pending while authorization is pending", async () => {
    vi.spyOn(deviceFlow, "pollDeviceFlow").mockResolvedValue({ status: "pending" });
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    expect(await linker.poll("user-1", "dc-1")).toEqual({ status: "pending" });
  });

  it("treats slow_down as pending", async () => {
    vi.spyOn(deviceFlow, "pollDeviceFlow").mockResolvedValue({ status: "slow_down", retryAfterSeconds: 10 });
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    expect(await linker.poll("user-1", "dc-1")).toEqual({ status: "pending" });
  });

  it("passes through expired/denied", async () => {
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    vi.spyOn(deviceFlow, "pollDeviceFlow").mockResolvedValueOnce({ status: "expired" });
    expect(await linker.poll("user-1", "dc-1")).toEqual({ status: "expired" });

    vi.spyOn(deviceFlow, "pollDeviceFlow").mockResolvedValueOnce({ status: "denied" });
    expect(await linker.poll("user-1", "dc-1")).toEqual({ status: "denied" });
  });

  it("on complete, looks up the GitHub login and persists the credential", async () => {
    vi.spyOn(deviceFlow, "pollDeviceFlow").mockResolvedValue({
      status: "complete",
      token: "gho_abc",
      refreshToken: "ghr_def",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    });
    const fetchImpl = makeFetchMock("octocat");
    const store = makeInMemoryStore();
    const setSpy = vi.spyOn(store, "set");
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store, fetchImpl });

    const result = await linker.poll("user-1", "dc-1");

    expect(result).toEqual({ status: "complete" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer gho_abc" }) }),
    );
    expect(setSpy).toHaveBeenCalledWith("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_abc",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_def",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("GithubDeviceFlowLinker.startAuthCode", () => {
  it("returns a well-formed authorize URL and TTL", async () => {
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({
      clientId: "client-1",
      scope: "repo",
      store,
      stateSecret: "state-secret",
      redirectUri: "https://gateway.example/identity-link/github/callback",
    });

    const result = await linker.startAuthCode("user-1");

    expect(result.flow).toBe("authcode");
    expect(result.expiresInSeconds).toBe(600);
    const parsed = new URL(result.authorizeUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://gateway.example/identity-link/github/callback");
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("state")).toBeTruthy();
  });

  it("throws when stateSecret is unset", async () => {
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({
      clientId: "client-1",
      scope: "repo",
      store,
      redirectUri: "https://gateway.example/identity-link/github/callback",
    });

    await expect(linker.startAuthCode("user-1")).rejects.toThrow(/stateSecret/);
  });

  it("throws when redirectUri is unset", async () => {
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({
      clientId: "client-1",
      scope: "repo",
      store,
      stateSecret: "state-secret",
    });

    await expect(linker.startAuthCode("user-1")).rejects.toThrow(/redirectUri/);
  });
});

describe("GithubDeviceFlowLinker.completeAuthCode", () => {
  const REDIRECT_URI = "https://gateway.example/identity-link/github/callback";
  const STATE_SECRET = "state-secret";
  const CLIENT_SECRET = "client-secret";

  function makeLinker(store: IdentityLinkStore, fetchImpl?: ReturnType<typeof vi.fn>): GithubDeviceFlowLinker {
    return new GithubDeviceFlowLinker({
      clientId: "client-1",
      scope: "repo",
      store,
      stateSecret: STATE_SECRET,
      redirectUri: REDIRECT_URI,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    });
  }

  it("succeeds and calls store.set with the right shape", async () => {
    const store = makeInMemoryStore();
    const setSpy = vi.spyOn(store, "set");
    const fetchImpl = makeFetchMock("octocat");
    const linker = makeLinker(store, fetchImpl);

    const { authorizeUrl } = await linker.startAuthCode("user-1");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    vi.spyOn(deviceFlow, "exchangeCodeForToken").mockResolvedValue({
      token: "gho_abc",
      refreshToken: "ghr_def",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    });

    const result = await linker.completeAuthCode(state, "the-code");

    expect(result).toEqual({ subject: "user-1" });
    expect(setSpy).toHaveBeenCalledWith("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_abc",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_def",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    });
  });

  it("returns undefined (not throw) on an invalid state", async () => {
    const store = makeInMemoryStore();
    const linker = makeLinker(store);

    const result = await linker.completeAuthCode("garbage-state", "the-code");

    expect(result).toBeUndefined();
  });

  it("returns undefined (not throw) when code exchange fails", async () => {
    const store = makeInMemoryStore();
    const linker = makeLinker(store);
    const { authorizeUrl } = await linker.startAuthCode("user-1");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    vi.spyOn(deviceFlow, "exchangeCodeForToken").mockRejectedValue(new Error("bad code"));

    await expect(linker.completeAuthCode(state, "the-code")).resolves.toBeUndefined();
  });
});

describe("GithubDeviceFlowLinker.getValidToken", () => {
  it("returns undefined when there is no stored link", async () => {
    const store = makeInMemoryStore();
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    expect(await linker.getValidToken("user-1")).toBeUndefined();
  });

  it("returns the stored token as-is when it is not close to expiry", async () => {
    const store = makeInMemoryStore();
    await store.set("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_fresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: "ghr_def",
      refreshExpiresAt: undefined,
    });
    const refreshSpy = vi.spyOn(deviceFlow, "refreshUserToken");
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    expect(await linker.getValidToken("user-1")).toEqual({ token: "gho_fresh", githubLogin: "octocat" });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("refreshes and persists a stale/expired token", async () => {
    const store = makeInMemoryStore();
    await store.set("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_stale",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshToken: "ghr_old",
      refreshExpiresAt: undefined,
    });
    vi.spyOn(deviceFlow, "refreshUserToken").mockResolvedValue({
      token: "gho_new",
      refreshToken: "ghr_new",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: undefined,
    });
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    const result = await linker.getValidToken("user-1");

    expect(result).toEqual({ token: "gho_new", githubLogin: "octocat" });
    const stored = await store.get("github", "user-1");
    expect(stored?.token).toBe("gho_new");
    expect(stored?.refreshToken).toBe("ghr_new");
  });

  it("returns undefined without a refresh token when the stored token is stale", async () => {
    const store = makeInMemoryStore();
    await store.set("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_stale",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshToken: undefined,
      refreshExpiresAt: undefined,
    });
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    expect(await linker.getValidToken("user-1")).toBeUndefined();
  });

  it("returns undefined (does not throw) when the refresh call fails", async () => {
    const store = makeInMemoryStore();
    await store.set("github", "user-1", {
      githubLogin: "octocat",
      token: "gho_stale",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshToken: "ghr_dead",
      refreshExpiresAt: undefined,
    });
    vi.spyOn(deviceFlow, "refreshUserToken").mockRejectedValue(new Error("refresh token expired"));
    const linker = new GithubDeviceFlowLinker({ clientId: "client-1", scope: undefined, store });

    await expect(linker.getValidToken("user-1")).resolves.toBeUndefined();
  });
});
