import { describe, expect, it } from "vitest";
import { chunkDocument, hashChunk } from "./chunk.js";
import type { Document } from "../drivers/types.js";

const connection = { id: "snc-confluence", label: "SNC Confluence" };

function doc(markdown: string, over: Partial<Document> = {}): Document {
  return {
    id: "page-1",
    title: "Auth design",
    url: "https://wiki/page-1",
    version: "v7",
    updatedAt: "2026-09-01T10:00:00Z",
    markdown,
    ...over,
  };
}

describe("chunkDocument", () => {
  it("cuts on headings, which is where the author changed subject", () => {
    const chunks = chunkDocument(
      connection,
      doc("# Auth\n\nWe use OIDC.\n\n# Storage\n\nPostgres.\n"),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain("We use OIDC.");
    expect(chunks[1]!.text).toContain("Postgres.");
  });

  it("keeps a heading with its body", () => {
    const chunks = chunkDocument(connection, doc("## Token refresh\n\nRotates hourly."));

    // The heading is usually the most retrievable line in a section; a body
    // separated from it loses the one line saying what it is about.
    expect(chunks[0]!.text).toContain("## Token refresh");
    expect(chunks[0]!.text).toContain("Rotates hourly.");
  });

  it("leaves a small section whole rather than merging across a heading", () => {
    const chunks = chunkDocument(connection, doc("# A\n\nshort\n\n# B\n\nalso short"));

    // Merging would undo the boundary the heading pass just respected.
    expect(chunks).toHaveLength(2);
  });

  it("splits an over-budget section on paragraph boundaries", () => {
    const paragraph = "x".repeat(400); // ~100 tokens
    const chunks = chunkDocument(connection, doc(`# Big\n\n${Array(10).fill(paragraph).join("\n\n")}`), {
      maxTokens: 200,
      overlap: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Never mid-sentence: every piece is whole paragraphs.
    for (const chunk of chunks) {
      expect(chunk.text.split(/\n{2,}/).every((p) => p.trim().length > 0)).toBe(true);
    }
  });

  it("overlaps adjacent chunks so a passage on a seam stays findable", () => {
    const a = "alpha ".repeat(60).trim();
    const b = "bravo ".repeat(60).trim();
    const c = "charlie ".repeat(60).trim();

    const chunks = chunkDocument(connection, doc(`# S\n\n${a}\n\n${b}\n\n${c}`), {
      maxTokens: 120,
      overlap: 120,
    });

    expect(chunks.length).toBeGreaterThan(1);
    // The tail of one chunk reappears at the head of the next.
    expect(chunks[1]!.text).toContain("bravo");
  });

  it("keeps an oversized single paragraph whole rather than severing a sentence", () => {
    const huge = "y".repeat(8000);
    const chunks = chunkDocument(connection, doc(`# S\n\n${huge}`), { maxTokens: 100, overlap: 0 });

    // An oversized chunk retrieves worse than a right-sized one; a severed
    // sentence is worse than both.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain(huge);
  });

  it("repeats the heading onto every piece of a split section", () => {
    const paragraph = "x".repeat(400);
    const chunks = chunkDocument(
      connection,
      doc(`## Token refresh\n\n${Array(6).fill(paragraph).join("\n\n")}`),
      { maxTokens: 200, overlap: 0 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    // Orphaning the heading would produce a contentless chunk that still
    // matches queries about the topic and then answers nothing, while stripping
    // the rest of the one line saying what they are about.
    for (const chunk of chunks) {
      expect(chunk.text).toContain("## Token refresh");
      expect(chunk.text.replace("## Token refresh", "").trim().length).toBeGreaterThan(0);
    }
  });

  it("carries provenance onto every chunk", () => {
    const chunks = chunkDocument(connection, doc("# A\n\none\n\n# B\n\ntwo"));

    for (const chunk of chunks) {
      expect(chunk.sourceUrl).toBe("https://wiki/page-1");
      expect(chunk.sourceId).toBe("page-1");
      expect(chunk.version).toBe("v7");
      expect(chunk.connectionLabel).toBe("SNC Confluence");
    }
  });

  it("carries the ACL the driver captured, including the permissive marker", () => {
    const chunks = chunkDocument(
      connection,
      doc("text", { acl: { principals: [], permissive: true } }),
    );

    // Over-inclusion costs a wasted probe; under-inclusion silently suppresses
    // results the user was entitled to see (ADR 0040).
    expect(chunks[0]!.aclPermissive).toBe(true);
  });

  it("drops empty sections rather than indexing blanks", () => {
    const chunks = chunkDocument(connection, doc("# A\n\n\n\n# B\n\nreal"));
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});

describe("hashChunk", () => {
  it("is stable across whitespace reflow", () => {
    // Editors reflow constantly; treating that as a change would re-embed a
    // corpus that did not actually change.
    expect(hashChunk("c", "s", "one two  three")).toBe(hashChunk("c", "s", "one\ntwo   three"));
  });

  it("changes when the text does", () => {
    expect(hashChunk("c", "s", "one two")).not.toBe(hashChunk("c", "s", "one three"));
  });

  it("separates the same sentence in two documents", () => {
    // Otherwise one document's chunk would silently stand in for another's.
    expect(hashChunk("c", "doc-a", "same")).not.toBe(hashChunk("c", "doc-b", "same"));
  });

  it("separates the same document in two connections", () => {
    expect(hashChunk("conn-a", "s", "same")).not.toBe(hashChunk("conn-b", "s", "same"));
  });
});
