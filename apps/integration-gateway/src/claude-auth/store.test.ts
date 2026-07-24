import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRedisState = new Map<string, string>();
const mockRedisChannels = new Map<string, Set<(message: string) => void>>();

/** Same fake as identity-link/store.test.ts's `FakeRedis` -- see that file's doc comment for why `connected` gates `subscribe()`. */
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
  async del(key: string): Promise<number> {
    return mockRedisState.delete(key) ? 1 : 0;
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

const { RedisClaudeTokenStore } = await import("./store.js");

const KEY = randomBytes(32);

describe("RedisClaudeTokenStore", () => {
  beforeEach(() => {
    mockRedisState.clear();
    mockRedisChannels.clear();
  });

  it("round-trips a setup-token record through encrypt/decrypt", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const record = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-123", record);
    expect(await store.get("user-123")).toEqual(record);
  });

  it("round-trips a login record through encrypt/decrypt", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const record = { kind: "login" as const, credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-login-1", record);
    expect(await store.get("user-login-1", "login")).toEqual(record);
  });

  it("keeps a setup-token record and a login record for the same subject independent", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const setupRecord = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    const loginRecord = { kind: "login" as const, credentialsJson: '{"accessToken":"other"}', createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-both", setupRecord);
    await store.set("user-both", loginRecord);
    expect(await store.get("user-both")).toEqual(setupRecord);
    expect(await store.get("user-both", "login")).toEqual(loginRecord);
  });

  it("returns undefined for an unknown subject", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    expect(await store.get("nobody")).toBeUndefined();
  });

  it("returns undefined for an unknown subject's login kind", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    expect(await store.get("nobody", "login")).toBeUndefined();
  });

  it("never stores the plaintext token substring", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-456", { kind: "setup-token", token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    const raw = mockRedisState.get("claudeAuth:user-456") ?? "";
    expect(raw).not.toContain("sk-ant-oat01-supersecret");
  });

  it("never stores the plaintext credentialsJson substring, under the login key prefix", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-login-2", { kind: "login", credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" });
    const raw = mockRedisState.get("claudeAuthLogin:user-login-2") ?? "";
    expect(raw).not.toContain("supersecret");
    expect(mockRedisState.has("claudeAuth:user-login-2")).toBe(false);
  });

  it("throws at construction on a malformed encryption key", () => {
    expect(() => new RedisClaudeTokenStore("redis://fake", Buffer.from("not32bytes"))).toThrow(/32 bytes/);
  });

  it("removes a subject's stored token on delete", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-789", { kind: "setup-token", token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    await store.delete("user-789");
    expect(await store.get("user-789")).toBeUndefined();
  });

  it("removes a subject's stored login record on delete without touching its setup-token record", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const setupRecord = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-999", setupRecord);
    await store.set("user-999", { kind: "login", credentialsJson: '{"accessToken":"x"}', createdAt: "2026-07-22T00:00:00.000Z" });
    await store.delete("user-999", "login");
    expect(await store.get("user-999", "login")).toBeUndefined();
    expect(await store.get("user-999")).toEqual(setupRecord);
  });
});

describe("RedisClaudeTokenStore.waitForCompletion", () => {
  const RECORD = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
  const LOGIN_RECORD = { kind: "login" as const, credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" };

  beforeEach(() => {
    mockRedisState.clear();
    mockRedisChannels.clear();
  });

  it("resolves immediately when a token is already stored", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-1", RECORD);
    await expect(store.waitForCompletion("user-1", 1000)).resolves.toEqual(RECORD);
  });

  it("resolves once a concurrent set() publishes completion", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const waiting = store.waitForCompletion("user-2", 5000);
    await store.set("user-2", RECORD);
    await expect(waiting).resolves.toEqual(RECORD);
  });

  it("resolves undefined once timeoutMs elapses with no completion", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await expect(store.waitForCompletion("nobody", 5)).resolves.toBeUndefined();
  });

  it("resolves immediately for a login record when kind='login' is passed", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-login-wait", LOGIN_RECORD);
    await expect(store.waitForCompletion("user-login-wait", 1000, "login")).resolves.toEqual(LOGIN_RECORD);
  });

  it("resolves once a concurrent login set() publishes completion on the login channel", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const waiting = store.waitForCompletion("user-login-wait-2", 5000, "login");
    await store.set("user-login-wait-2", LOGIN_RECORD);
    await expect(waiting).resolves.toEqual(LOGIN_RECORD);
  });

  it("does not resolve a login waiter from a concurrent setup-token set() for the same subject", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const waiting = store.waitForCompletion("user-mixed", 50, "login");
    await store.set("user-mixed", RECORD);
    await expect(waiting).resolves.toBeUndefined();
  });
});
