import { describe, expect, it } from "vitest";
import { reconcile, type IndexedChunk } from "./reconcile.js";
import type { Chunk } from "./chunk.js";

function chunk(sourceId: string, contentHash: string, text = "t"): Chunk {
  return {
    connectionId: "c",
    connectionLabel: "#c",
    sourceId,
    sourceUrl: `https://wiki/${sourceId}`,
    title: sourceId,
    contentHash,
    text,
  };
}

const indexed = (...pairs: [string, string][]): IndexedChunk[] =>
  pairs.map(([sourceId, contentHash]) => ({ sourceId, contentHash }));

describe("reconcile", () => {
  it("embeds only what changed", () => {
    const plan = reconcile(
      [chunk("page-1", "h1"), chunk("page-1", "h2-new")],
      indexed(["page-1", "h1"], ["page-1", "h2-old"]),
      { kind: "full" },
    );

    // The whole incremental story: a document nobody edited costs zero
    // embeddings.
    expect(plan.upsert.map((c) => c.contentHash)).toEqual(["h2-new"]);
    expect(plan.unchanged).toBe(1);
    expect(plan.remove).toEqual(["h2-old"]);
  });

  it("costs nothing when nothing moved", () => {
    const plan = reconcile([chunk("p", "h1")], indexed(["p", "h1"]), { kind: "full" });

    expect(plan.upsert).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("removes what a full pass no longer finds", () => {
    const plan = reconcile([], indexed(["deleted-page", "h1"]), { kind: "full" });

    // A full pass walked everything, so absent really is gone — which is how a
    // deleted page leaves the corpus without any tombstone machinery.
    expect(plan.remove).toEqual(["h1"]);
  });

  it("NEVER deletes outside the sources a partial pass examined", () => {
    const plan = reconcile(
      [chunk("page-1", "h1-new")],
      indexed(["page-1", "h1-old"], ["page-2", "h2"], ["page-3", "h3"]),
      { kind: "partial", sourceIds: ["page-1"] },
    );

    // The failure this scoping exists to prevent: a webhook fires for one page,
    // every other page looks indexed-and-absent, and the corpus is wiped down
    // to whatever changed in the last minute.
    expect(plan.remove).toEqual(["h1-old"]);
    expect(plan.remove).not.toContain("h2");
    expect(plan.remove).not.toContain("h3");
  });

  it("deletes a partially-synced page's chunks when it lost content", () => {
    const plan = reconcile(
      [chunk("page-1", "h1")],
      indexed(["page-1", "h1"], ["page-1", "h2-removed"]),
      { kind: "partial", sourceIds: ["page-1"] },
    );

    // In scope, so absence is meaningful: the page genuinely got shorter.
    expect(plan.remove).toEqual(["h2-removed"]);
  });

  it("removes every chunk of a page a partial pass found empty", () => {
    const plan = reconcile([], indexed(["page-1", "h1"], ["page-2", "h2"]), {
      kind: "partial",
      sourceIds: ["page-1"],
    });

    expect(plan.remove).toEqual(["h1"]);
  });

  it("writes a repeated passage once", () => {
    const plan = reconcile([chunk("p", "same"), chunk("p", "same")], [], { kind: "full" });

    // A document may legitimately say the same thing twice; it is one point,
    // and writing it twice would be a wasted embedding.
    expect(plan.upsert).toHaveLength(1);
  });

  it("treats an empty corpus as all-new", () => {
    const plan = reconcile([chunk("p", "h1"), chunk("p", "h2")], [], { kind: "full" });

    expect(plan.upsert).toHaveLength(2);
    expect(plan.unchanged).toBe(0);
    expect(plan.remove).toEqual([]);
  });

  it("does nothing at all for a partial pass that touched nothing", () => {
    const plan = reconcile([], indexed(["page-1", "h1"]), { kind: "partial", sourceIds: [] });

    expect(plan.upsert).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
});
