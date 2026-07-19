import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_SIDE_CLOSE = { serverSideClose: true };

interface FakeWatchCall {
  path: string;
  callback: (phase: string, obj: unknown) => void;
  done: (err: unknown) => void;
  abort: AbortController;
}

const watchCalls: FakeWatchCall[] = [];

vi.mock("@kubernetes/client-node", () => {
  class FakeWatch {
    static SERVER_SIDE_CLOSE = SERVER_SIDE_CLOSE;
    constructor(_config: unknown) {}
    watch(path: string, _queryParams: unknown, callback: (phase: string, obj: unknown) => void, done: (err: unknown) => void) {
      const abort = new AbortController();
      watchCalls.push({ path, callback, done, abort });
      return Promise.resolve(abort);
    }
  }
  return { Watch: FakeWatch };
});

// Import after the mock so the module under test picks up FakeWatch.
const { makeCrdWatcher } = await import("./crd-watcher.js");

describe("makeCrdWatcher", () => {
  beforeEach(() => {
    watchCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the watch path from group/version/namespace/plural and forwards ADDED/MODIFIED/DELETED", async () => {
    const watchFn = makeCrdWatcher({} as never);
    const events: Array<[string, unknown]> = [];
    watchFn({ group: "core.controller-agent.dev", version: "v1alpha1", namespace: "default", plural: "tools" }, (phase, obj) =>
      events.push([phase, obj]),
    );
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));

    expect(watchCalls[0]!.path).toBe("/apis/core.controller-agent.dev/v1alpha1/namespaces/default/tools");

    watchCalls[0]!.callback("ADDED", { metadata: { name: "a" } });
    watchCalls[0]!.callback("MODIFIED", { metadata: { name: "a" } });
    watchCalls[0]!.callback("DELETED", { metadata: { name: "a" } });
    watchCalls[0]!.callback("BOOKMARK", { metadata: { name: "a" } });

    expect(events.map(([phase]) => phase)).toEqual(["ADDED", "MODIFIED", "DELETED"]);
  });

  it("reconnects after a clean server-side close without calling onError", async () => {
    const watchFn = makeCrdWatcher({} as never);
    const onError = vi.fn();
    watchFn({ group: "g", version: "v1", namespace: "ns", plural: "tools" }, () => {}, onError);
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));

    watchCalls[0]!.done(SERVER_SIDE_CLOSE);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(watchCalls).toHaveLength(2));

    expect(onError).not.toHaveBeenCalled();
  });

  it("reconnects after an error and reports it via onError", async () => {
    const watchFn = makeCrdWatcher({} as never);
    const onError = vi.fn();
    watchFn({ group: "g", version: "v1", namespace: "ns", plural: "tools" }, () => {}, onError);
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));

    const err = new Error("connection reset");
    watchCalls[0]!.done(err);
    expect(onError).toHaveBeenCalledWith(err);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(watchCalls).toHaveLength(2));
  });

  it("stop() aborts the in-flight watch and prevents further reconnects", async () => {
    const watchFn = makeCrdWatcher({} as never);
    const handle = watchFn({ group: "g", version: "v1", namespace: "ns", plural: "tools" }, () => {});
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));

    const abort = watchCalls[0]!.abort;
    handle.stop();
    expect(abort.signal.aborted).toBe(true);

    watchCalls[0]!.done(SERVER_SIDE_CLOSE);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchCalls).toHaveLength(1);
  });
});
