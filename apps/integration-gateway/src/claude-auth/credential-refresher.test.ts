import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCredentialRefresher,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  credentialExpiresAt,
  needsRefresh,
  refreshCredentialsBlob,
} from "./credential-refresher.js";
import type { ClaudeTokenRecord } from "./store.js";

const HOUR = 3_600_000;

function blob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: Date.now() + 8 * HOUR,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...overrides,
    },
  });
}

function okResponse(body: Record<string, unknown>): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errResponse(status: number, text = ""): Response {
  return { ok: false, status, text: async () => text } as unknown as Response;
}

/** In-memory `login`-only store with the read-back behaviour the real one has. */
function fakeStore(initial?: string) {
  const records = new Map<string, ClaudeTokenRecord>();
  if (initial !== undefined) records.set("github:alice", { kind: "login", credentialsJson: initial, createdAt: "t0" });
  return {
    records,
    get: vi.fn(async (subject: string) => records.get(subject)),
    set: vi.fn(async (subject: string, record: ClaudeTokenRecord) => {
      records.set(subject, record);
    }),
  };
}

describe("needsRefresh / credentialExpiresAt", () => {
  it("leaves a comfortably valid credential alone", () => {
    expect(needsRefresh(blob({ expiresAt: Date.now() + 8 * HOUR }))).toBe(false);
  });

  it("refreshes inside the margin, and when already expired", () => {
    expect(needsRefresh(blob({ expiresAt: Date.now() + 60_000 }))).toBe(true);
    expect(needsRefresh(blob({ expiresAt: Date.now() - HOUR }))).toBe(true);
  });

  // An unknown expiry is far more likely to be an expired credential than a
  // healthy one, and a needless refresh costs a round trip while a skipped one
  // costs the user a re-link.
  it("treats a blob with no readable expiry as due", () => {
    expect(needsRefresh(JSON.stringify({ claudeAiOauth: { refreshToken: "rt" } }))).toBe(true);
  });

  it("reports expiry without exposing token material", () => {
    const at = Date.UTC(2026, 6, 28, 12, 0, 0);
    const expiry = credentialExpiresAt(blob({ expiresAt: at }));
    expect(expiry).toBe("2026-07-28T12:00:00.000Z");
    expect(expiry).not.toContain("rt-old");
  });
});

describe("refreshCredentialsBlob", () => {
  it("posts the standard refresh grant and merges the new tokens, preserving unrelated fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800, scope: "user:inference user:profile" }),
    );
    const outcome = await refreshCredentialsBlob(blob(), { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });

    expect(outcome.status).toBe("refreshed");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLAUDE_TOKEN_URL);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
    expect(body.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID);

    const merged = JSON.parse(outcome.credentialsJson ?? "{}").claudeAiOauth;
    expect(merged.accessToken).toBe("at-new");
    expect(merged.refreshToken).toBe("rt-new");
    expect(merged.expiresAt).toBe(1_000 + 28800 * 1000);
    expect(merged.scopes).toEqual(["user:inference", "user:profile"]);
    // Fields this code has no business understanding must survive, or runs get
    // a blob subtly unlike the one `claude auth login` produces.
    expect(merged.subscriptionType).toBe("max");
  });

  it("carries the old refresh token forward when the response omits a new one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ access_token: "at-new", expires_in: 3600 }));
    const outcome = await refreshCredentialsBlob(blob(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(outcome.credentialsJson ?? "{}").claudeAiOauth.refreshToken).toBe("rt-old");
  });

  it("calls a spent/expired refresh token a rejection -- retrying cannot help", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errResponse(400, '{"error":"invalid_grant"}'));
    expect((await refreshCredentialsBlob(blob(), { fetchImpl: fetchImpl as unknown as typeof fetch })).status).toBe("rejected");
  });

  it("calls anything else transient, so the stored credential is left alone and retried later", async () => {
    for (const res of [errResponse(503), errResponse(500), errResponse(400, '{"error":"server_error"}')]) {
      const fetchImpl = vi.fn().mockResolvedValue(res);
      expect((await refreshCredentialsBlob(blob(), { fetchImpl: fetchImpl as unknown as typeof fetch })).status).toBe("transient");
    }
    const throwing = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await refreshCredentialsBlob(blob(), { fetchImpl: throwing as unknown as typeof fetch })).status).toBe("transient");
  });

  // A 200 we cannot use must NOT be treated as a refresh: claiming success here
  // would overwrite a working credential with a broken one.
  it("treats a 200 with no usable tokens as transient, not refreshed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ hello: "world" }));
    expect((await refreshCredentialsBlob(blob(), { fetchImpl: fetchImpl as unknown as typeof fetch })).status).toBe("transient");
  });

  it("does not attempt a blob with no refresh token", async () => {
    const fetchImpl = vi.fn();
    const outcome = await refreshCredentialsBlob(JSON.stringify({ claudeAiOauth: { accessToken: "a" } }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unrefreshable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ClaudeCredentialRefresher.ensureFresh", () => {
  it("refreshes a near-expiry credential and persists it before returning", async () => {
    const store = fakeStore(blob({ expiresAt: Date.now() + 60_000 }));
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 }));
    const refresher = new ClaudeCredentialRefresher({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    const served = await refresher.ensureFresh("github:alice");

    expect(JSON.parse(served ?? "{}").claudeAiOauth.accessToken).toBe("at-new");
    // Persisted, because the old refresh token is dead the instant the service
    // answered -- this blob is now the only living copy.
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.records.get("github:alice")?.credentialsJson ?? "{}").claudeAiOauth.refreshToken).toBe("rt-new");
  });

  it("serves a healthy credential untouched, without calling the token endpoint", async () => {
    const store = fakeStore(blob({ expiresAt: Date.now() + 8 * HOUR }));
    const fetchImpl = vi.fn();
    const refresher = new ClaudeCredentialRefresher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });

    await refresher.ensureFresh("github:alice");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  // Two concurrent launches for one subject would otherwise each spend the same
  // refresh token, and whichever landed second would invalidate the first --
  // the exact rotation race that makes runs fragile, reproduced in the gateway.
  it("collapses concurrent callers onto ONE refresh", async () => {
    const store = fakeStore(blob({ expiresAt: Date.now() + 60_000 }));
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    const refresher = new ClaudeCredentialRefresher({ store, fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });

    const both = Promise.all([refresher.ensureFresh("github:alice"), refresher.ensureFresh("github:alice")]);
    await new Promise((r) => setTimeout(r, 5));
    resolveFetch?.(okResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 }));
    const [a, b] = await both;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("serves the stored credential unchanged when a refresh fails -- never worse off than before", async () => {
    const original = blob({ expiresAt: Date.now() + 60_000 });
    const store = fakeStore(original);
    const refresher = new ClaudeCredentialRefresher({
      store,
      fetchImpl: vi.fn().mockResolvedValue(errResponse(503)) as unknown as typeof fetch,
      log: () => {},
    });

    expect(await refresher.ensureFresh("github:alice")).toBe(original);
    expect(store.set).not.toHaveBeenCalled();
  });

  // Deleting here would let a refresh-endpoint hiccup that merely looked like a
  // rejection cost a working link; the orchestrator's re-auth path owns
  // invalidation.
  it("does not delete a rejected credential -- it reports and leaves it", async () => {
    const original = blob({ expiresAt: Date.now() - HOUR });
    const store = fakeStore(original);
    const logs: string[] = [];
    const refresher = new ClaudeCredentialRefresher({
      store,
      fetchImpl: vi.fn().mockResolvedValue(errResponse(400, '{"error":"invalid_grant"}')) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });

    expect(await refresher.ensureFresh("github:alice")).toBe(original);
    expect(store.records.has("github:alice")).toBe(true);
    expect(logs.join("\n")).toMatch(/rejected/);
  });

  // `set` swallows its own storage errors by design, so a silent drop would be
  // indistinguishable from success -- and it is the one outcome that destroys
  // the link, because the old refresh token is already spent.
  it("shouts, and still serves the live blob, when the refreshed credential will not persist", async () => {
    const store = fakeStore(blob({ expiresAt: Date.now() + 60_000 }));
    store.set = vi.fn(async () => {
      /* silently drops it, exactly as the real store can */
    });
    const logs: string[] = [];
    const refresher = new ClaudeCredentialRefresher({
      store,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(okResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 })) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });

    const served = await refresher.ensureFresh("github:alice");

    expect(JSON.parse(served ?? "{}").claudeAiOauth.accessToken).toBe("at-new");
    expect(logs.join("\n")).toMatch(/STORED-BUT-UNVERIFIED/);
    expect(logs.join("\n")).toMatch(/need re-linking/);
  });

  it("is inert when disabled, and for a subject with no credential", async () => {
    const original = blob({ expiresAt: Date.now() - HOUR });
    const off = new ClaudeCredentialRefresher({ store: fakeStore(original), enabled: false, fetchImpl: vi.fn() as unknown as typeof fetch, log: () => {} });
    expect(await off.ensureFresh("github:alice")).toBe(original);

    const empty = new ClaudeCredentialRefresher({ store: fakeStore(), fetchImpl: vi.fn() as unknown as typeof fetch, log: () => {} });
    expect(await empty.ensureFresh("github:nobody")).toBeUndefined();
  });
});
