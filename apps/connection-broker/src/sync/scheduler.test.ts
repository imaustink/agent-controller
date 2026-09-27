import { describe, expect, it, vi } from "vitest";
import { SyncScheduler } from "./scheduler.js";
import type { ConnectionBinding } from "../registry.js";
import type { CorpusWriter, ResourceSource } from "./worker.js";

const binding = (name: string): ConnectionBinding =>
  ({ name, allowedRoles: ["reader"], serviceToken: "t", scope: { space: "S" } }) as ConnectionBinding;

function deps(overrides: { list?: ResourceSource["list"] } = {}) {
  const source: ResourceSource = {
    list: overrides.list ?? (async () => ({ resources: [], cursor: undefined })),
    fetch: async () => ({ id: "1", title: "t", url: "u", markdown: "m" }),
  };
  const writer: CorpusWriter = {
    indexed: async () => [],
    upsert: async () => {},
    remove: async () => {},
  };
  return { source, writer };
}

describe("runOnce", () => {
  it("syncs the named connection", async () => {
    const { source, writer } = deps();
    const scheduler = new SyncScheduler({
      sourceFor: () => source,
      writerFor: () => writer,
      targets: () => [{ binding: binding("a"), collection: "coll-a", intervalMs: 60_000 }],
    });

    const report = await scheduler.runOnce("a");
    expect(report?.connection).toBe("a");
  });

  it("builds a writer PER CONNECTION", async () => {
    const { source, writer } = deps();
    const writerFor = vi.fn(() => writer);
    const scheduler = new SyncScheduler({
      sourceFor: () => source,
      writerFor,
      targets: () => [
        { binding: binding("a"), collection: "coll-a", intervalMs: 60_000 },
        { binding: binding("b"), collection: "coll-b", intervalMs: 60_000 },
      ],
    });

    await scheduler.runOnce("a");
    await scheduler.runOnce("b");

    // Each point carries its own connection's allowedRoles. One shared writer
    // would stamp one client's roles onto another client's chunks.
    expect(writerFor.mock.calls.map(([b]) => b.name)).toEqual(["a", "b"]);
  });

  it("builds a source PER CONNECTION, so each pass carries its own token", async () => {
    const { writer } = deps();
    // Stand in for HttpResourceSource: each connection's source is stamped with
    // that connection's own sync token, mirroring how index.ts looks a token up
    // by binding name.
    const tokens: Record<string, string> = { a: "token-a", b: "token-b" };
    const used: { connection: string; token: string }[] = [];
    const sourceFor = vi.fn((b: ConnectionBinding) => {
      const token = tokens[b.name]!;
      return {
        list: async (connection: string) => {
          used.push({ connection, token });
          return { resources: [], cursor: undefined };
        },
        fetch: async () => ({ id: "1", title: "t", url: "u", markdown: "m" }),
      } satisfies ResourceSource;
    });
    const scheduler = new SyncScheduler({
      sourceFor,
      writerFor: () => writer,
      targets: () => [
        { binding: binding("a"), collection: "coll-a", intervalMs: 60_000 },
        { binding: binding("b"), collection: "coll-b", intervalMs: 60_000 },
      ],
    });

    await scheduler.runOnce("a");
    await scheduler.runOnce("b");

    // The broker scopes each sync token to one connection, so a shared source
    // carrying one token would 403 on every other connection's list and never
    // index it. Each pass must reach the broker with its own connection's token.
    expect(sourceFor.mock.calls.map(([b]) => b.name)).toEqual(["a", "b"]);
    expect(used).toEqual([
      { connection: "a", token: "token-a" },
      { connection: "b", token: "token-b" },
    ]);
  });

  it("refuses to start a second pass while one is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { writer } = deps();
    const source: ResourceSource = {
      list: async () => {
        await gate;
        return { resources: [], cursor: undefined };
      },
      fetch: async () => ({ id: "1", title: "t", url: "u", markdown: "m" }),
    };
    const scheduler = new SyncScheduler({
      sourceFor: () => source,
      writerFor: () => writer,
      targets: () => [{ binding: binding("a"), collection: "coll-a", intervalMs: 1 }],
    });

    const first = scheduler.runOnce("a");
    // Two concurrent full passes can each conclude the other's freshly written
    // chunks are absent — and a full pass deletes what it believes is absent.
    const second = await scheduler.runOnce("a");
    expect(second).toBeUndefined();

    release();
    expect((await first)?.connection).toBe("a");
  });

  it("reports a failing pass rather than throwing out of the timer", async () => {
    const { writer } = deps();
    const onError = vi.fn();
    const scheduler = new SyncScheduler({
      sourceFor: () => ({
        list: async () => {
          throw new Error("broker down");
        },
        fetch: async () => ({ id: "1", title: "t", url: "u", markdown: "m" }),
      }),
      writerFor: () => writer,
      targets: () => [{ binding: binding("a"), collection: "coll-a", intervalMs: 60_000 }],
      onError,
    });

    // An unhandled rejection inside a timer takes the process down, and a
    // broker that dies because one source was unreachable stops serving every
    // other client's probes too.
    await expect(scheduler.runOnce("a")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error));
  });

  it("does nothing for a connection it does not know", async () => {
    const { source, writer } = deps();
    const scheduler = new SyncScheduler({ sourceFor: () => source, writerFor: () => writer, targets: () => [] });
    expect(await scheduler.runOnce("gone")).toBeUndefined();
  });
});

describe("scheduling", () => {
  it("re-reads targets each cycle, so an edited interval takes effect", async () => {
    vi.useFakeTimers();
    const { source, writer } = deps();
    const targets = vi.fn(() => [{ binding: binding("a"), collection: "coll-a", intervalMs: 1_000 }]);
    const scheduler = new SyncScheduler({ sourceFor: () => source, writerFor: () => writer, targets });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    const callsAfterFirst = targets.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);

    // A Connection edited mid-flight should not need a restart, and one that
    // has gone away should stop rescheduling itself.
    expect(targets.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("stops cleanly", async () => {
    vi.useFakeTimers();
    const { source, writer } = deps();
    const targets = vi.fn(() => [{ binding: binding("a"), collection: "c", intervalMs: 1_000 }]);
    const scheduler = new SyncScheduler({ sourceFor: () => source, writerFor: () => writer, targets });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stop();
    const before = targets.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(targets.mock.calls.length).toBe(before);
    vi.useRealTimers();
  });
});
