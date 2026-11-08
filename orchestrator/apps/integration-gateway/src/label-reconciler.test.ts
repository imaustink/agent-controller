import { describe, expect, it, vi } from "vitest";
import {
  InMemoryPendingLabelStore,
  LabelReconciler,
  type PendingLabelRemoval,
} from "./label-reconciler.js";
import { OrchestratorClient } from "./orchestrator-client.js";

const NOW = 1_000_000_000_000;

function entry(overrides: Partial<PendingLabelRemoval> = {}): PendingLabelRemoval {
  return {
    owner: "acme",
    repo: "widgets",
    issueNumber: 7,
    label: "ai-triage",
    sessionId: "github:acme/widgets#7",
    recordedAt: NOW - 60 * 60 * 1000, // an hour old by default -> past any sane grace
    ...overrides,
  };
}

describe("LabelReconciler.sweepOnce", () => {
  it("removes an orphaned label for a terminal run and clears the record", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockResolvedValue(undefined);

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: async () => true, // run is no longer live == terminal
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).toHaveBeenCalledWith("acme", "widgets", 7, "ai-triage");
    // Cleared -> a second sweep does nothing (the heal happens exactly once).
    expect(await store.list()).toHaveLength(0);
    removeLabel.mockClear();
    await reconciler.sweepOnce();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("leaves a label alone while its run is still live (not orphaned)", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockResolvedValue(undefined);

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: async () => false, // still running -> its own finally will handle it
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).not.toHaveBeenCalled();
    // Record kept so a later sweep retries once the run finishes.
    expect(await store.list()).toHaveLength(1);
  });

  it("respects the grace window: a just-recorded removal is not acted on", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry({ recordedAt: NOW - 1000 })); // 1s old
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    const isRunTerminal = vi.fn().mockResolvedValue(true);

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal,
      removeLabel,
      graceMs: 10 * 60 * 1000,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    // Too fresh: not even probed for liveness, let alone removed.
    expect(isRunTerminal).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it("is idempotent: a removal that 404s (already gone) still clears the record and does not throw", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    // github-client treats 404 as success, so removeLabel RESOLVES on an
    // already-gone label. The reconciler must then clear the record normally.
    const removeLabel = vi.fn().mockResolvedValue(undefined);

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: async () => true,
      removeLabel,
      now: () => NOW,
    });
    await expect(reconciler.sweepOnce()).resolves.toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it("keeps the record and reports the error when removal ultimately fails, so a later sweep retries", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockRejectedValue(new Error("502 bad gateway"));
    const onError = vi.fn();

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: async () => true,
      removeLabel,
      onError,
      now: () => NOW,
    });
    await expect(reconciler.sweepOnce()).resolves.toBeUndefined(); // never throws
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "502 bad gateway" }));
    // Record survives for the next sweep to retry.
    expect(await store.list()).toHaveLength(1);
  });

  it("handles several records independently in one sweep", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry({ sessionId: "github:acme/widgets#1", issueNumber: 1 }));
    await store.record(entry({ sessionId: "github:acme/widgets#2", issueNumber: 2, label: "ai-review" }));
    const removeLabel = vi.fn().mockResolvedValue(undefined);

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: async (sessionId) => sessionId.endsWith("#1"), // only #1 is terminal
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).toHaveBeenCalledTimes(1);
    expect(removeLabel).toHaveBeenCalledWith("acme", "widgets", 1, "ai-triage");
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.issueNumber).toBe(2);
  });
});

describe("LabelReconciler + production isRunTerminal wiring (transient-vs-confirmed terminal)", () => {
  // Mirrors server.ts: a run is terminal ONLY on a confirmed not-live probe,
  // never on a transient/indeterminate one. Built from a real OrchestratorClient
  // so the test exercises the actual predicate shipped in production.
  function isRunTerminalFor(fetchImpl: typeof fetch) {
    const client = new OrchestratorClient({
      baseUrl: "http://orchestrator:8081",
      token: "tok",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      fetchImpl,
    });
    return async (sessionId: string): Promise<boolean> =>
      (await client.probeLive(sessionId)).status === "not-live";
  }

  it("does NOT strip a PAST-GRACE label when the liveness probe errors (orchestrator blip mid-run)", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry()); // an hour old -> well past grace
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    // Probe rejects (connection refused) -> "unknown", NOT confirmed terminal.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as typeof fetch;

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: isRunTerminalFor(fetchImpl),
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    // A still-running turn that is only transiently unreachable must keep its label.
    expect(removeLabel).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it("does NOT strip a PAST-GRACE label when the liveness probe returns a non-ok response (5xx)", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    // Non-ok (503) -> "unknown", NOT confirmed terminal.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: isRunTerminalFor(fetchImpl),
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it("DOES strip a PAST-GRACE label once the probe CONFIRMS the run is not live (a real 200 saying not-live)", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    // A real 200 body saying { live: false } -> confirmed terminal.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: false }),
    }) as unknown as typeof fetch;

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: isRunTerminalFor(fetchImpl),
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).toHaveBeenCalledWith("acme", "widgets", 7, "ai-triage");
    expect(await store.list()).toHaveLength(0);
  });

  it("does NOT strip a PAST-GRACE label while the probe confirms the run is still live", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry());
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: true, agentRunId: "run-42" }),
    }) as unknown as typeof fetch;

    const reconciler = new LabelReconciler({
      store,
      isRunTerminal: isRunTerminalFor(fetchImpl),
      removeLabel,
      now: () => NOW,
    });
    await reconciler.sweepOnce();

    expect(removeLabel).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });
});

describe("InMemoryPendingLabelStore", () => {
  it("records, lists, and clears by (sessionId, label); triage and review on one session are independent", async () => {
    const store = new InMemoryPendingLabelStore();
    await store.record(entry({ label: "ai-triage" }));
    await store.record(entry({ label: "ai-review" }));
    expect(await store.list()).toHaveLength(2);

    await store.clear("github:acme/widgets#7", "ai-triage");
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.label).toBe("ai-review");

    // Clearing something already gone is a no-op, not an error.
    await expect(store.clear("github:acme/widgets#7", "ai-triage")).resolves.toBeUndefined();
  });
});
