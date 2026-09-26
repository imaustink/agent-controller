import { describe, expect, it, vi } from "vitest";
import { CorpusStatusWriter } from "./corpus-status.js";
import type { SyncReport } from "./sync/worker.js";

const NOW = new Date("2026-09-26T12:00:00.000Z");

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    connection: "snc-confluence",
    indexed: 3,
    removed: 0,
    unchanged: 97,
    failed: [],
    full: true,
    ...overrides,
  };
}

function writer(patch = vi.fn().mockResolvedValue({}), onError = vi.fn()) {
  return {
    patch,
    onError,
    writer: new CorpusStatusWriter({
      api: { patchNamespacedCustomObjectStatus: patch },
      namespace: "clients",
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      plural: "corpora",
      now: () => NOW,
      onError,
    }),
  };
}

const patchedStatus = (patch: ReturnType<typeof vi.fn>) =>
  (patch.mock.calls[0]![0] as { body: { status: Record<string, unknown> } }).body.status;

describe("record", () => {
  it("publishes what the pass did, onto the named corpus", async () => {
    const { writer: w, patch } = writer();
    await w.record("snc-confluence", report());

    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ plural: "corpora", name: "snc-confluence", namespace: "clients" }),
    );
    // Total indexed material, not just what this pass touched — an unchanged
    // chunk is still in the corpus.
    expect(patchedStatus(patch).resources).toBe(100);
  });

  it("moves lastReconcileTime only on a FULL pass", async () => {
    // Staleness asks what we might have MISSED, and only a full pass could have
    // noticed a deletion (ADR 0038 §4).
    const { writer: w, patch } = writer();
    await w.record("c", report({ full: true }));

    expect(patchedStatus(patch).lastReconcileTime).toBe(NOW.toISOString());
  });

  it("moves lastSyncTime but NOT lastReconcileTime on a partial pass", async () => {
    // A webhook delivery means material arrived, which is not the same as
    // having checked for what went away.
    const { writer: w, patch } = writer();
    await w.record("c", report({ full: false }));

    const status = patchedStatus(patch);
    expect(status.lastSyncTime).toBe(NOW.toISOString());
    expect(status.lastReconcileTime).toBeUndefined();
  });

  it("reports a failed write rather than failing the sync", async () => {
    // The pass already happened and the chunks are indexed. Throwing here would
    // discard real work to protect a timestamp.
    const patch = vi.fn().mockRejectedValue(new Error("conflict"));
    const onError = vi.fn();
    const { writer: w } = writer(patch, onError);

    await expect(w.record("c", report())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("c", expect.any(Error));
  });

  it("patches the STATUS subresource, not the spec", async () => {
    const { writer: w, patch } = writer();
    await w.record("c", report());

    // Writing through the main resource would fight the operator's own edits
    // and lose the field on the next apply.
    const body = (patch.mock.calls[0]![0] as { body: Record<string, unknown> }).body;
    expect(Object.keys(body)).toEqual(["status"]);
  });
});
