import { describe, expect, it, vi } from "vitest";
import { compileEventSource, CrdEventSourceRegistry, SecretKeyReader, type CrdWatchApi } from "./event-sources.js";

const webhook = (name: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name },
  spec: {
    webhook: { verify: { scheme: "hmacSha256", header: "x-sig", prefix: "sha256=", secretRef: { name: "s", key: "k" } } },
    ...extra,
  },
});

describe("compileEventSource", () => {
  it("compiles a webhook source with a sender (dropBots defaults to true)", () => {
    const r = compileEventSource(webhook("github", { sender: { provider: "github", loginFrom: "body.sender.login" } }) as never);
    expect(r.ok).toBe(true);
    if (r.ok && r.source.kind === "webhook") expect(r.source.sender?.dropBots).toBe(true);
  });

  it("marks a source whose sender CEL does not compile as unusable", () => {
    expect(compileEventSource(webhook("bad", { sender: { provider: "github", loginFrom: "body.sender.login +" } }) as never).ok).toBe(false);
    expect(compileEventSource(webhook("bad2", { sender: { provider: "github", loginFrom: "nosuchvar.x" } }) as never).ok).toBe(false);
  });

  it("rejects neither/both of webhook and cron, sender on cron, and hmacSha256 without a header", () => {
    expect(compileEventSource({ metadata: { name: "x" }, spec: {} } as never).ok).toBe(false);
    expect(compileEventSource({ metadata: { name: "x" }, spec: { cron: { schedule: "* * * * *" }, sender: { provider: "github", loginFrom: "''" } } } as never).ok).toBe(false);
    expect(
      compileEventSource({ metadata: { name: "x" }, spec: { webhook: { verify: { scheme: "hmacSha256", secretRef: { name: "s", key: "k" } } } } } as never).ok,
    ).toBe(false);
    expect(
      compileEventSource({ metadata: { name: "x" }, spec: { webhook: { verify: { scheme: "none", secretRef: { name: "s", key: "k" } } } } } as never).ok,
    ).toBe(false);
  });
});

describe("CrdEventSourceRegistry", () => {
  it("lists, applies watch events, and relists (dropping vanished sources) on reconnect", async () => {
    let items: unknown[] = [webhook("a"), webhook("b")];
    const api = { listNamespacedCustomObject: vi.fn(async () => ({ items, metadata: { resourceVersion: "7" } })) };
    let onEvent: ((phase: string, obj: unknown) => void) | undefined;
    let onDone: ((err?: unknown) => void) | undefined;
    const watch: CrdWatchApi = {
      watch: vi.fn(async (_path, _q, e, d) => {
        onEvent = e;
        onDone = d;
        return { abort: () => {} };
      }),
    };
    const registry = new CrdEventSourceRegistry({ namespace: "ns", group: "g", version: "v1", api, watch, reconnectDelayMs: 1, log: () => {} });
    await registry.start();
    expect(registry.get("a")).toBeDefined();
    expect(watch.watch).toHaveBeenCalledWith("/apis/g/v1/namespaces/ns/eventsources", { resourceVersion: "7" }, expect.any(Function), expect.any(Function));

    onEvent!("ADDED", webhook("c"));
    onEvent!("DELETED", webhook("a"));
    onEvent!("MODIFIED", webhook("b", { sender: { provider: "github", loginFrom: "(" } }));
    expect(registry.get("c")).toBeDefined();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeUndefined(); // broken edit -> unusable, not the last good copy

    items = [webhook("d")];
    onDone!();
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.get("c")).toBeUndefined();
    expect(registry.get("d")).toBeDefined();
    registry.stop();
  });
});

describe("SecretKeyReader", () => {
  it("decodes the key, caches it, treats missing as undefined, and refreshes on demand (rate-limited)", async () => {
    let now = 0;
    let value = "one";
    const api = {
      readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
        if (name === "missing") throw Object.assign(new Error("not found"), { code: 404 });
        return { data: { token: Buffer.from(value).toString("base64") } };
      }),
    };
    const reader = new SecretKeyReader({ api, namespace: "ns", ttlMs: 1000, minRefreshIntervalMs: 100, now: () => now });
    expect(await reader.get("s", "token")).toBe("one");
    value = "two";
    expect(await reader.get("s", "token")).toBe("one"); // cached
    expect(await reader.get("s", "token", { refresh: true })).toBe("one"); // too soon to force
    now = 150;
    expect(await reader.get("s", "token", { refresh: true })).toBe("two");
    expect(await reader.get("s", "nokey")).toBeUndefined();
    expect(await reader.get("missing", "token")).toBeUndefined();
  });
});
