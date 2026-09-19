import { describe, expect, it, vi } from "vitest";
import { syncConnection, type CorpusWriter, type ResourceSource } from "./worker.js";
import type { IndexedChunk } from "./reconcile.js";
import type { Chunk } from "./chunk.js";
import type { Document, ResourceRef } from "../drivers/types.js";

const target = { connection: "snc-confluence", label: "SNC Confluence", collection: "coll" };

function doc(id: string, markdown: string): Document {
  return { id, title: id, url: `https://wiki/${id}`, version: "v1", markdown };
}

/** Pages `refs` out in slices, so pagination is actually exercised. */
function source(
  docs: Record<string, Document>,
  opts: { pageSize?: number; failFetch?: string[]; neverEnds?: boolean } = {},
): ResourceSource & { fetches: string[] } {
  const ids = Object.keys(docs);
  const pageSize = opts.pageSize ?? ids.length;
  const fetches: string[] = [];

  return {
    fetches,
    async list(_c, cursor) {
      if (opts.neverEnds) return { resources: [{ id: "x" } as ResourceRef], cursor: "more" };
      const start = Number(cursor ?? "0");
      const slice = ids.slice(start, start + pageSize);
      const next = start + slice.length;
      return {
        resources: slice.map((id) => ({ id }) as ResourceRef),
        cursor: next >= ids.length ? undefined : String(next),
      };
    },
    async fetch(_c, id) {
      fetches.push(id);
      if (opts.failFetch?.includes(id)) throw new Error("403 from source");
      return docs[id]!;
    },
  };
}

function corpus(indexed: IndexedChunk[] = []): CorpusWriter & { upserted: Chunk[]; removed: string[] } {
  const upserted: Chunk[] = [];
  const removed: string[] = [];
  return {
    upserted,
    removed,
    async indexed() {
      return indexed;
    },
    async upsert(_c, chunks) {
      upserted.push(...chunks);
    },
    async remove(_c, hashes) {
      removed.push(...hashes);
    },
  };
}

describe("syncConnection", () => {
  it("walks every page and indexes what it finds", async () => {
    const src = source({ "page-1": doc("page-1", "# A\n\none"), "page-2": doc("page-2", "# B\n\ntwo") }, { pageSize: 1 });
    const store = corpus();

    const report = await syncConnection(src, store, target);

    expect(src.fetches).toEqual(["page-1", "page-2"]);
    expect(report.indexed).toBe(2);
    expect(report.full).toBe(true);
  });

  it("re-embeds nothing when nothing changed", async () => {
    const src = source({ "page-1": doc("page-1", "# A\n\none") });
    const first = corpus();
    await syncConnection(src, first, target);

    // Feed the first pass's output back as what is already indexed.
    const already = first.upserted.map((c) => ({ contentHash: c.contentHash, sourceId: c.sourceId }));
    const second = corpus(already);
    const report = await syncConnection(src, second, target);

    expect(report.indexed).toBe(0);
    expect(report.unchanged).toBe(1);
    expect(second.upserted).toEqual([]);
  });

  it("removes a page a full pass no longer finds", async () => {
    const store = corpus([{ contentHash: "gone", sourceId: "deleted-page" }]);

    const report = await syncConnection(source({}), store, target);

    // How a deleted page leaves the corpus with no tombstone machinery.
    expect(store.removed).toEqual(["gone"]);
    expect(report.removed).toBe(1);
  });

  it("does not delete outside the sources a webhook flush examined", async () => {
    const src = source({ "page-1": doc("page-1", "# A\n\nupdated") });
    const store = corpus([
      { contentHash: "stale-1", sourceId: "page-1" },
      { contentHash: "other", sourceId: "page-2" },
    ]);

    await syncConnection(src, store, target, { onlySourceIds: ["page-1"] });

    expect(store.removed).toEqual(["stale-1"]);
    // The corpus would otherwise be wiped down to whatever changed last minute.
    expect(store.removed).not.toContain("other");
  });

  it("downgrades a full pass that could not read everything", async () => {
    const src = source(
      { "page-1": doc("page-1", "# A\n\none"), "page-2": doc("page-2", "# B\n\ntwo") },
      { failFetch: ["page-2"] },
    );
    const store = corpus([{ contentHash: "page-2-chunk", sourceId: "page-2" }]);

    const report = await syncConnection(src, store, target);

    // A transient outage must not be read as a deletion: page-2 could not be
    // examined, so its chunks survive.
    expect(report.full).toBe(false);
    expect(report.failed).toEqual(["page-2"]);
    expect(store.removed).not.toContain("page-2-chunk");
  });

  it("reports an unreadable resource rather than skipping it silently", async () => {
    const src = source({ "page-1": doc("page-1", "x"), "bad": doc("bad", "y") }, { failFetch: ["bad"] });

    const report = await syncConnection(src, corpus(), target);

    // A corpus that quietly shrinks while every pass claims success is the
    // failure the reconcile backstop exists to catch.
    expect(report.failed).toEqual(["bad"]);
    expect(report.indexed).toBeGreaterThan(0);
  });

  it("refuses to walk forever", async () => {
    await expect(
      syncConnection(source({}, { neverEnds: true }), corpus(), target, { maxPages: 3 }),
    ).rejects.toThrow(/did not finish listing/);
  });

  it("writes nothing when there is nothing to do", async () => {
    const src = source({});
    const store = corpus();
    const upsert = vi.spyOn(store, "upsert");
    const remove = vi.spyOn(store, "remove");

    await syncConnection(src, store, target);

    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
