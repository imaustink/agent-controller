import { describe, expect, it } from "vitest";

import type { AuthorizedChunk } from "./probe.js";
import { rerank } from "./rerank.js";

function authChunk(
  score: number,
  title: string,
  text: string,
  connectionId: string,
  sourceId: string,
): AuthorizedChunk {
  return {
    score,
    title,
    url: `https://example.test/${sourceId}`,
    stale: false,
    chunk: {
      connectionId,
      sourceId,
      sourceUrl: `https://example.test/${sourceId}`,
      contentHash: sourceId,
      title,
      text,
    },
  };
}

const order = (chunks: AuthorizedChunk[]): string[] => chunks.map((c) => c.chunk.sourceId);

describe("rerank", () => {
  it("promotes a keyword match within the score band", () => {
    // Pure vector order is C (0.9), A (0.6), B (0.55). Only B contains every
    // query term; the keyword weight lifts it above A — which contains none —
    // while C stays on top. This CAN fail: with the keyword weight at zero the
    // order would stay C, A, B.
    const query = "migration pipeline schema";
    const chunks = [
      authChunk(0.9, "Overview", "general notes about the client", "c1", "s-c"),
      authChunk(0.6, "Notes", "unrelated meeting discussion", "c1", "s-a"),
      authChunk(0.55, "Plan", "the migration pipeline schema rollout plan", "c1", "s-b"),
    ];

    expect(order(rerank(query, chunks))).toEqual(["s-c", "s-b", "s-a"]);
  });

  it("keeps vector order when no keyword matches", () => {
    const query = "migration pipeline schema";
    const chunks = [
      authChunk(0.9, "A", "nothing relevant here", "c1", "s-a"),
      authChunk(0.5, "B", "also nothing of interest", "c1", "s-b"),
    ];

    expect(order(rerank(query, chunks))).toEqual(["s-a", "s-b"]);
  });

  it("tie-breaks deterministically on equal score and no keyword signal", () => {
    const chunks = [
      authChunk(0.5, "", "", "c2", "s2"),
      authChunk(0.5, "", "", "c1", "s9"),
      authChunk(0.5, "", "", "c1", "s1"),
    ];

    expect(order(rerank("anything here", chunks))).toEqual(["s1", "s9", "s2"]);
  });

  it("is a no-op below two chunks", () => {
    expect(rerank("q", [])).toEqual([]);
    const one = [authChunk(0.1, "t", "x", "c", "s")];
    expect(rerank("q", one)).toEqual(one);
  });
});
