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

  it("round-trips a token through encrypt/decrypt", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    const record = { token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-123", record);
    expect(await store.get("user-123")).toEqual(record);
  });

  it("returns undefined for an unknown subject", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    expect(await store.get("nobody")).toBeUndefined();
  });

  it("never stores the plaintext token substring", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-456", { token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    const raw = mockRedisState.get("claudeAuth:user-456") ?? "";
    expect(raw).not.toContain("sk-ant-oat01-supersecret");
  });

  it("throws at construction on a malformed encryption key", () => {
    expect(() => new RedisClaudeTokenStore("redis://fake", Buffer.from("not32bytes"))).toThrow(/32 bytes/);
  });

  it("removes a subject's stored token on delete", async () => {
    const store = new RedisClaudeTokenStore("redis://fake", KEY);
    await store.set("user-789", { token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    await store.delete("user-789");
    expect(await store.get("user-789")).toBeUndefined();
  });
});

describe("RedisClaudeTokenStore.waitForCompletion", () => {
  const RECORD = { token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };

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
});
