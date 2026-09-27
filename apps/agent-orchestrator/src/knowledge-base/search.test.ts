import { describe, expect, it } from "vitest";
import { searchCorpus } from "./search.js";
import type { CorpusQueryFilter, CorpusSearchResult, CorpusStore } from "./types.js";

function hit(
  connectionId: string,
  sourceId: string,
  contentHash: string,
  score: number,
): CorpusSearchResult {
  return {
    score,
    chunk: {
      connectionId,
      connectionLabel: `#${connectionId}`,
      sourceUrl: `https://example.test/${connectionId}/${sourceId}`,
      sourceId,
      contentHash,
      text: `…${sourceId}…`,
    },
  };
}

/**
 * One member collection. Records the roles it was queried with so the fan-out's
 * fail-closed behaviour can be asserted, and can be made to fail to exercise
 * partial degradation.
 */
class FakeStore implements CorpusStore {
  readonly queriedFor: string[][] = [];

  constructor(
    private readonly hits: CorpusSearchResult[] = [],
    private readonly failure?: Error,
  ) {}

  async query(_text: string, filter: CorpusQueryFilter, k: number) {
    this.queriedFor.push(filter.callerRoles);
    if (this.failure) throw this.failure;
    // A real store returns the top-k BY SCORE, not the first k it happens to
    // hold, and the fan-out's pruning depends on that.
    return [...this.hits].sort((a, b) => b.score - a.score).slice(0, k);
  }
}

describe("searchCorpus", () => {
  it("merges members by score", async () => {
    const confluence = new FakeStore([
      hit("globex-confluence", "page-1", "hash-a", 0.91),
      hit("globex-confluence", "page-2", "hash-b", 0.42),
    ]);
    const slack = new FakeStore([hit("globex-slack-eng", "msg-1", "hash-c", 0.77)]);

    const { hits, skipped } = await searchCorpus(
      [confluence, slack],
      "how is auth configured",
      ["reader"],
      10,
    );

    expect(skipped).toBe(0);
    expect(hits.map((h) => h.chunk.contentHash)).toEqual(["hash-a", "hash-c", "hash-b"]);
  });

  it("passes caller roles to every member", async () => {
    const first = new FakeStore();
    const second = new FakeStore();

    await searchCorpus([first, second], "q", ["reader", "lead"], 5);

    // Per-chunk filtering is defense in depth behind the source-level filter,
    // so the roles must reach every member rather than being trusted to have
    // been applied upstream.
    expect(first.queriedFor).toEqual([["reader", "lead"]]);
    expect(second.queriedFor).toEqual([["reader", "lead"]]);
  });

  it("de-duplicates the same passage reached through two connections", async () => {
    // A document in a Drive folder that is also linked into a synced Confluence
    // space: one fact, two connections, one content hash.
    const drive = new FakeStore([hit("globex-drive", "doc-7", "same-hash", 0.55)]);
    const confluence = new FakeStore([hit("globex-confluence", "page-9", "same-hash", 0.81)]);

    const { hits } = await searchCorpus([drive, confluence], "q", ["reader"], 10);

    // A cited answer must not list two URLs for one fact.
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.connectionId).toBe("globex-confluence");
  });

  it("is deterministic across runs", async () => {
    // Identical scores from a parallel fan-out have no meaningful arrival
    // order, so the tiebreak must not depend on which promise settled first.
    const build = () => [
      new FakeStore([hit("bbb", "s1", "h1", 0.5)]),
      new FakeStore([hit("aaa", "s2", "h2", 0.5)]),
      new FakeStore([hit("ccc", "s3", "h3", 0.5)]),
    ];

    const first = await searchCorpus(build(), "q", ["reader"], 10);
    for (let i = 0; i < 20; i += 1) {
      const again = await searchCorpus(build(), "q", ["reader"], 10);
      // The same question twice must cite the same sources.
      expect(again).toEqual(first);
    }
  });

  it("prunes to the limit", async () => {
    const many = Array.from({ length: 8 }, (_, i) => hit("c", `s${i}`, `h${i}`, i / 10));

    const { hits } = await searchCorpus([new FakeStore(many)], "q", ["reader"], 3);

    expect(hits).toHaveLength(3);
    expect(hits[0].chunk.contentHash).toBe("h7");
  });

  it("degrades when one member fails", async () => {
    const healthy = new FakeStore([hit("ok", "s1", "h1", 0.6)]);
    const broken = new FakeStore([], new Error("qdrant unreachable"));

    const { hits, skipped } = await searchCorpus([healthy, broken], "q", ["reader"], 10);

    // One unreachable member must not fail the whole knowledge base, but the
    // caller has to be able to say part of it was missed.
    expect(skipped).toBe(1);
    expect(hits).toHaveLength(1);
  });

  it("throws when every member fails", async () => {
    const broken = () => new FakeStore([], new Error("qdrant unreachable"));

    // Returning "no results" here would be a confident lie about the client's
    // material, which is worse than an error.
    await expect(searchCorpus([broken(), broken()], "q", ["reader"], 10)).rejects.toThrow(
      /every corpus in this knowledge base failed/,
    );
  });

  it("rejects a non-positive limit", async () => {
    await expect(searchCorpus([new FakeStore()], "q", ["reader"], 0)).rejects.toThrow();
  });

  it("returns nothing when no member is visible", async () => {
    const { hits, skipped } = await searchCorpus([], "q", ["reader"], 10);
    expect(hits).toEqual([]);
    expect(skipped).toBe(0);
  });
});
