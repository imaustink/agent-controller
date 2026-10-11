import { describe, expect, it, vi } from "vitest";
import type { ClaudeTokenRecord, ClaudeTokenStore } from "../claude-auth/store.js";
import type { GithubDeviceFlowLinker } from "../identity-link/device-flow-linker.js";
import type { OAuthAuthCodeLinker } from "../identity-link/oauth-authcode-linker.js";
import type { IdentityLinkStore, LinkedCredential } from "../identity-link/store.js";
import { buildConnectionProviders, credentialStatus } from "./providers.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const cred = (overrides: Partial<LinkedCredential> = {}): LinkedCredential => ({
  githubLogin: "",
  token: "t",
  expiresAt: iso(3600_000),
  refreshToken: undefined,
  refreshExpiresAt: undefined,
  ...overrides,
});

class MemStore implements IdentityLinkStore {
  readonly records = new Map<string, LinkedCredential>();
  async get(p: string, s: string) {
    return this.records.get(`${p}/${s}`);
  }
  async set(p: string, s: string, c: LinkedCredential) {
    this.records.set(`${p}/${s}`, c);
  }
  async waitForCompletion() {
    return undefined;
  }
  async delete(p: string, s: string) {
    this.records.delete(`${p}/${s}`);
  }
}

function claudeStore(records: Record<string, ClaudeTokenRecord> = {}) {
  const map = new Map(Object.entries(records));
  return {
    map,
    store: {
      get: vi.fn(async (s: string, k = "setup-token") => map.get(`${s}/${k}`)),
      delete: vi.fn(async (s: string, k = "setup-token") => void map.delete(`${s}/${k}`)),
    } as unknown as ClaudeTokenStore,
  };
}

describe("credentialStatus", () => {
  it("is not-connected without a credential", () => {
    expect(credentialStatus(undefined, NOW)).toEqual({ state: "not-connected" });
  });

  it("is connected while the access token is alive", () => {
    expect(credentialStatus(cred({ accountId: "acc-1" }), NOW)).toEqual({ state: "connected", account: "acc-1" });
  });

  it("stays connected past access expiry while a refresh token can renew it", () => {
    expect(credentialStatus(cred({ expiresAt: iso(-1), refreshToken: "r", refreshExpiresAt: iso(1000) }), NOW).state).toBe(
      "connected",
    );
  });

  it("needs reconnecting once nothing can produce a token", () => {
    expect(credentialStatus(cred({ expiresAt: iso(-1) }), NOW).state).toBe("needs-reconnect");
    expect(credentialStatus(cred({ expiresAt: iso(-1), refreshToken: "r", refreshExpiresAt: iso(-1) }), NOW).state).toBe(
      "needs-reconnect",
    );
  });

  // Slack user tokens do not expire; the store records that as an empty expiry.
  it("treats an empty expiry as non-expiring", () => {
    expect(credentialStatus(cred({ expiresAt: "" }), NOW).state).toBe("connected");
  });

  it("prefers the GitHub login as the account name", () => {
    expect(credentialStatus(cred({ githubLogin: "octocat" }), NOW).account).toBe("octocat");
  });
});

describe("buildConnectionProviders", () => {
  const github = { startAuthCode: vi.fn(async () => ({ authorizeUrl: "https://github.test/authorize" })) };
  const google = { startAuthCode: vi.fn(() => ({ authorizeUrl: "https://accounts.google.test/auth", expiresInSeconds: 600 })) };

  it("lists configured providers in a stable order", () => {
    const providers = buildConnectionProviders({
      store: new MemStore(),
      authCodeLinkers: new Map([["google", google as unknown as OAuthAuthCodeLinker]]),
      githubLinker: github as unknown as GithubDeviceFlowLinker,
      claude: { store: claudeStore().store, start: vi.fn(), loginEnabled: true },
    });
    expect(providers.map((p) => p.id)).toEqual(["github", "claude", "claude-remote", "google"]);
  });

  it("omits GitHub when its authcode flow is not configured", () => {
    const providers = buildConnectionProviders({ store: new MemStore() });
    expect(providers.map((p) => p.id)).toEqual([]);
  });

  it("connects and disconnects an identity-link provider under the chat subject", async () => {
    const store = new MemStore();
    const [p] = buildConnectionProviders({
      store,
      authCodeLinkers: new Map([["google", google as unknown as OAuthAuthCodeLinker]]),
      now: () => NOW,
    });
    expect(await p!.connect("openwebui:1")).toEqual({ redirect: "https://accounts.google.test/auth" });
    expect(google.startAuthCode).toHaveBeenCalledWith("openwebui:1");

    await store.set("google", "openwebui:1", cred());
    expect((await p!.status("openwebui:1")).state).toBe("connected");
    await p!.disconnect("openwebui:1");
    expect(store.records.size).toBe(0);
  });

  describe("Claude", () => {
    it("is blocked until GitHub establishes the principal", async () => {
      const start = vi.fn();
      const [, claude] = buildConnectionProviders({
        store: new MemStore(),
        githubLinker: github as unknown as GithubDeviceFlowLinker,
        claude: { store: claudeStore().store, start, loginEnabled: false },
      });
      expect(await claude!.status("openwebui:1")).toEqual({ state: "blocked", detail: "Connect GitHub first." });
      expect(await claude!.connect("openwebui:1")).toEqual({ blocked: "Connect GitHub first." });
      expect(start).not.toHaveBeenCalled();
    });

    // Must match agent-orchestrator's canonical principal exactly, or the
    // page would file a credential no agent run ever looks up.
    it("files the credential under the lower-cased github principal", async () => {
      const store = new MemStore();
      await store.set("github", "openwebui:1", cred({ githubLogin: "OctoCat" }));
      const start = vi.fn(async () => "https://gw.test/claude-auth/flow");
      const { store: cStore, map } = claudeStore();
      const [, claude] = buildConnectionProviders({
        store,
        githubLinker: github as unknown as GithubDeviceFlowLinker,
        claude: { store: cStore, start, loginEnabled: false },
      });

      expect(await claude!.connect("openwebui:1")).toEqual({ redirect: "https://gw.test/claude-auth/flow" });
      expect(start).toHaveBeenCalledWith("github:octocat", "setup-token");

      map.set("github:octocat/setup-token", { kind: "setup-token", token: "t", createdAt: iso(0) });
      expect(await claude!.status("openwebui:1")).toEqual({ state: "connected" });

      await claude!.disconnect("openwebui:1");
      expect(map.size).toBe(0);
    });

    // Remote Control needs the credentials file a real `claude auth login`
    // produces; a token minted any other way and passed in by env breaks the
    // session URL. The page must use the SAME login flow chat does, never
    // the setup-token one.
    it("links Remote Control through the full-login flow, never setup-token", async () => {
      const store = new MemStore();
      await store.set("github", "openwebui:1", cred({ githubLogin: "octocat" }));
      const start = vi.fn(async () => "https://gw.test/claude-auth/flow?mode=login");
      const providers = buildConnectionProviders({
        store,
        githubLinker: github as unknown as GithubDeviceFlowLinker,
        claude: { store: claudeStore().store, start, loginEnabled: true },
      });
      const remote = providers.find((p) => p.id === "claude-remote")!;

      await remote.connect("openwebui:1");

      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith("github:octocat", "login");
    });

    it("offers no Remote Control card when the login flow is not wired up", () => {
      const providers = buildConnectionProviders({
        store: new MemStore(),
        claude: { store: claudeStore().store, start: vi.fn(), loginEnabled: false },
      });
      expect(providers.map((p) => p.id)).not.toContain("claude-remote");
    });

    it("still sees a record filed under the raw subject before principals existed", async () => {
      const store = new MemStore();
      await store.set("github", "openwebui:1", cred({ githubLogin: "octocat" }));
      const { store: cStore } = claudeStore({
        "openwebui:1/setup-token": { kind: "setup-token", token: "t", createdAt: iso(0) },
      });
      const [, claude] = buildConnectionProviders({
        store,
        githubLinker: github as unknown as GithubDeviceFlowLinker,
        claude: { store: cStore, start: vi.fn(), loginEnabled: false },
      });
      expect((await claude!.status("openwebui:1")).state).toBe("connected");
    });
  });
});
