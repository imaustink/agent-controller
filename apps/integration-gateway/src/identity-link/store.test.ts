import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRedisState = new Map<string, string>();
/** Fake broker shared by every `FakeRedis` instance and its `.duplicate()`s -- mirrors real Redis pub/sub being a single shared bus, not per-connection state. */
const mockRedisChannels = new Map<string, Set<(message: string) => void>>();

/**
 * Minimal fake satisfying the subset of the ioredis interface
 * `RedisIdentityLinkStore` uses -- no real Redis required. `ioredis-mock` is
 * not a dependency here, so this hand-rolls just `get`/`set`/`connect`/
 * `ping`/`quit`/`on`/`publish`/`subscribe`/`duplicate`, following the "inject
 * a minimal mock" guidance rather than the (nonexistent)
 * `redis-session-store.test.ts` pattern.
 *
 * `connected` starts `false` and only flips on an explicit `connect()` call --
 * mirroring real ioredis's `lazyConnect: true` + `enableOfflineQueue: false`
 * combination, where a freshly-`duplicate()`d client's `subscribe()` rejects
 * synchronously ("Stream isn't writeable and enableOfflineQueue options is
 * false") if issued before its own `connect()` resolves, rather than queuing.
 * Without this, the fake previously let `subscribe()` silently no-op-succeed
 * on an unconnected duplicate, masking a real bug (store.ts calling
 * `subscriber.subscribe()` without ever connecting the duplicate first).
 */
class FakeRedis {
  private readonly messageHandlers: ((channel: string, message: string) => void)[] = [];
  private connected = false;

  on(event: string, handler: (channel: string, message: string) => void): void {
    if (event === "message") this.messageHandlers.push(handler);
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async ping(): Promise<void> {}
  async quit(): Promise<void> {
    this.connected = false;
  }
  async get(key: string): Promise<string | null> {
    return mockRedisState.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    mockRedisState.set(key, value);
    return "OK";
  }
  async publish(channel: string, message: string): Promise<number> {
    const subscribers = mockRedisChannels.get(channel);
    if (!subscribers) return 0;
    for (const notify of subscribers) notify(message);
    return subscribers.size;
  }
  async subscribe(channel: string): Promise<void> {
    if (!this.connected) {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    const notify = (message: string): void => {
      for (const handler of this.messageHandlers) handler(channel, message);
    };
    const subscribers = mockRedisChannels.get(channel) ?? new Set();
    subscribers.add(notify);
    mockRedisChannels.set(channel, subscribers);
  }
  duplicate(): FakeRedis {
    return new FakeRedis();
  }
}

vi.mock("ioredis", () => ({ Redis: FakeRedis }));

// Imported after the mock so RedisIdentityLinkStore picks up the fake Redis.
const { RedisIdentityLinkStore, decodeEncryptionKey } = await import("./store.js");

const KEY = randomBytes(32);

describe("decodeEncryptionKey", () => {
  it("decodes a 32-byte base64 key", () => {
    const raw = KEY.toString("base64");
    expect(decodeEncryptionKey(raw)).toEqual(KEY);
  });

  it("decodes a 32-byte hex key", () => {
    const raw = KEY.toString("hex");
    expect(decodeEncryptionKey(raw)).toEqual(KEY);
  });

  it("throws on a malformed/wrong-length key", () => {
    expect(() => decodeEncryptionKey("too-short")).toThrow(/32 bytes/);
  });
});

describe("RedisIdentityLinkStore", () => {
  beforeEach(() => {
    mockRedisState.clear();
    mockRedisChannels.clear();
  });

  it("round-trips a credential through encrypt/decrypt", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    const cred = {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_alsosecret",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    await store.set("github", "user-123", cred);
    const result = await store.get("github", "user-123");
    expect(result).toEqual(cred);
  });

  it("returns undefined for an unknown subject", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    expect(await store.get("github", "nobody")).toBeUndefined();
  });

  it("never stores the plaintext token substring", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    await store.set("github", "user-456", {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_alsosecret",
      refreshExpiresAt: undefined,
    });
    const raw = mockRedisState.get("identityLink:github:user-456") ?? "";
    expect(raw).not.toContain("gho_supersecret");
    expect(raw).not.toContain("ghr_alsosecret");
  });

  it("throws at construction on a malformed encryption key", () => {
    expect(() => new RedisIdentityLinkStore("redis://fake", Buffer.from("not32bytes"))).toThrow(/32 bytes/);
  });

  it("handles a credential with no refresh token", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    const cred = {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: undefined,
      refreshExpiresAt: undefined,
    };
    await store.set("github", "user-789", cred);
    expect(await store.get("github", "user-789")).toEqual(cred);
  });
});

describe("RedisIdentityLinkStore.waitForCompletion", () => {
  const CRED = {
    githubLogin: "octocat",
    token: "gho_supersecret",
    expiresAt: "2026-07-20T12:00:00.000Z",
    refreshToken: undefined,
    refreshExpiresAt: undefined,
  };

  beforeEach(() => {
    mockRedisState.clear();
    mockRedisChannels.clear();
  });

  it("resolves immediately when a credential is already stored", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    await store.set("github", "user-1", CRED);
    await expect(store.waitForCompletion("github", "user-1", 1000)).resolves.toEqual(CRED);
  });

  it("resolves once a concurrent set() publishes completion", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    const waiting = store.waitForCompletion("github", "user-2", 5000);
    await store.set("github", "user-2", CRED);
    await expect(waiting).resolves.toEqual(CRED);
  });

  it("resolves undefined once timeoutMs elapses with no completion", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    await expect(store.waitForCompletion("github", "nobody", 5)).resolves.toBeUndefined();
  });

  // Regression test for a bug where the duplicated pub/sub subscriber was
  // never explicitly `connect()`-ed before `subscribe()` was called on it.
  // Real ioredis duplicates inherit `lazyConnect: true` + `enableOfflineQueue:
  // false`, so an unconnected `subscribe()` rejects synchronously instead of
  // queuing -- which was being silently swallowed by the catch block,
  // collapsing every call into an instant, honest-looking "timeout" no
  // matter how large `timeoutMs` was or how quickly a concurrent `set()`
  // landed. This left the "I'll continue automatically once you finish"
  // auto-continue promise unfulfilled in production: the caller always fell
  // back to the old "send any message once you're done" behavior.
  it("does not resolve to a false timeout instantly when a completion arrives well within timeoutMs", async () => {
    const store = new RedisIdentityLinkStore("redis://fake", KEY);
    const start = Date.now();
    const waiting = store.waitForCompletion("github", "user-3", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.set("github", "user-3", CRED);
    const result = await waiting;
    expect(result).toEqual(CRED);
    // A swallowed subscribe() failure would fall straight through to the
    // 60s timer instead, so this bounds how long the resolution took.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
