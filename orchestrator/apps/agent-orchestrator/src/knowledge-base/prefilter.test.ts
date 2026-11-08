import { describe, expect, it } from "vitest";
import { preFilter } from "./prefilter.js";
import type { CorpusSearchResult } from "./types.js";

/**
 * PARITY: `prefilter_test.go`. These cases are deliberately the same ones, so a
 * divergence between the engines shows up as a failing test rather than as one
 * knowledge base answering differently depending on who served the turn.
 */
function hit(aclPrincipals?: string[], aclPermissive = false): CorpusSearchResult {
  return {
    score: 0.5,
    chunk: {
      connectionId: "c",
      sourceId: "page-1",
      sourceUrl: "https://wiki/page-1",
      contentHash: "h",
      text: "t",
      aclPrincipals,
      aclPermissive,
    },
  };
}

describe("preFilter", () => {
  const caller = ["user:acc-1", "group:eng"];

  it.each([
    ["restricted to someone else", hit(["user:acc-2"]), true],
    ["restricted to a group the caller is not in", hit(["group:finance"]), true],
    ["restricted to the caller", hit(["user:acc-1"]), false],
    ["restricted to the caller's group", hit(["group:eng"]), false],
    ["one of several matches", hit(["user:acc-9", "group:eng"]), false],
    // Permissive and empty both mean "not a usable exclusion set", for
    // different reasons, and neither may drop anything.
    ["permissive", hit(["user:acc-2"], true), false],
    ["no restrictions at all", hit(undefined), false],
  ])("%s", (_name, candidate, shouldDrop) => {
    const { kept, dropped } = preFilter([candidate as CorpusSearchResult], caller);
    expect({ kept: kept.length, dropped }).toEqual(shouldDrop ? { kept: 0, dropped: 1 } : { kept: 1, dropped: 0 });
  });

  it("will not exclude on a principal kind it cannot evaluate", () => {
    // The failure this is mostly written to avoid: a caller whose groups have
    // not been resolved holds only `user:` principals, and a group-restricted
    // page matches none of them. Dropping on that basis would hide every
    // group-restricted page from exactly the people entitled to read it.
    const { kept, dropped } = preFilter([hit(["group:eng"])], ["user:acc-1"]);
    expect({ kept: kept.length, dropped }).toEqual({ kept: 1, dropped: 0 });
  });

  it("excludes on a mix only once every kind is covered", () => {
    expect(preFilter([hit(["user:acc-2", "group:finance"])], ["user:acc-1"]).kept).toHaveLength(1);
    expect(
      preFilter([hit(["user:acc-2", "group:finance"])], ["user:acc-1", "group:eng"]).kept,
    ).toHaveLength(0);
  });

  it("filters nothing when the caller has no principals", () => {
    // An identity we could not resolve is not evidence of exclusion, and the
    // probes still gate every candidate — the cost is latency, not a leak.
    const { kept, dropped } = preFilter([hit(["user:acc-2"]), hit(["group:finance"])], []);
    expect({ kept: kept.length, dropped }).toEqual({ kept: 2, dropped: 0 });
  });

  it("splits a principal on its FIRST colon only", () => {
    // Atlassian account ids look like "557058:0e9503b6-…", so splitting on the
    // last colon would read the kind as "557058" and never match.
    const id = "user:557058:0e9503b6-3eb2-437d-9373-7dc8062ac23c";
    expect(preFilter([hit([id])], [id]).kept).toHaveLength(1);
  });
});
