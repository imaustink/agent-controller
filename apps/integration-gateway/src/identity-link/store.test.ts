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
 */
class FakeRedis {
  private readonly messageHandlers: ((channel: string, message: string) => void)[] = [];

  on(event: string, handler: (channel: string, message: string) => void): void {
    if (event === "message") this.messageHandlers.push(handler);
  }
  async connect(): Promise<void> {}
  async ping(): Promise<void> {}
  async quit(): Promise<void> {}
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
});
