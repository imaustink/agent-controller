import { describe, expect, it, vi } from "vitest";
import { CorpusRecent } from "./recent.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool = {
  id: "kb:snc/recent",
  name: "What's new in SNC",
  description: "…",
  allowedRoles: ["reader"],
  knowledgeBaseExec: {
    knowledgeBaseId: "snc",
    displayName: "SNC",
    operation: "recent",
    members: [
      { id: "snc-slack-team", label: "#team-snc", collection: "c1", allowedRoles: ["reader"], identityProviders: ["slack"] },
      { id: "snc-confluence", label: "SNC Confluence", collection: "c2", allowedRoles: ["reader"], identityProviders: ["atlassian"] },
    ],
    disclosePartialVisibility: true,
  },
} as unknown as ToolDescriptor;

const READER = { subject: "openwebui:42", roles: ["reader"] };

// No default parameter for the token: `recent(http, undefined)` must mean
// "nothing linked", and a default would silently turn that into the happy path.
function recent(fetchImpl: typeof fetch, ...token: [string | undefined] | []) {
  const resolved = token.length === 0 ? "user-token" : token[0];
  return new CorpusRecent({
    brokerUrl: "http://broker.test/",
    brokerToken: "orchestrator-secret",
    credentials: {
      delegatedToken: vi.fn().mockResolvedValue(resolved ? { token: resolved } : undefined),
      delegatedTokens: vi.fn().mockResolvedValue(new Map()),
    },
    fetchImpl,
  });
}

const hits = (...items: Record<string, string>[]) =>
  ({ ok: true, status: 200, json: async () => ({ hits: items }), text: async () => "" }) as Response;

describe("CorpusRecent", () => {
  // Each source orders by its own clock; the answer is the merge, newest first,
  // numbered on from the turn's earlier results. PARITY: corpus_recent_test.go.
  it("merges every source newest first and numbers from the turn's next citation", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("snc-slack-team")
        ? hits({ id: "C1/2", title: "teams isn't starting", url: "https://slack/2", updatedAt: "2026-09-21T15:00:00Z" })
        : hits({ id: "p1", title: "Monthly Prep", url: "https://wiki/p1", updatedAt: "2026-09-22T09:00:00Z" }),
    );

    const result = await recent(http as unknown as typeof fetch).recent(tool, "", READER, 4);

    expect(http).toHaveBeenCalledTimes(2);
    expect(String(http.mock.calls[0]![0])).toContain("/recent?limit=10");
    expect(result.result.indexOf("[4] Monthly Prep")).toBeGreaterThan(-1);
    expect(result.result.indexOf("[4] Monthly Prep")).toBeLessThan(result.result.indexOf("[5] teams isn't starting"));
    expect(result.result).toContain("reference: snc-confluence/p1");
    expect(result.sources).toEqual([
      { n: 4, title: "Monthly Prep", url: "https://wiki/p1" },
      { n: 5, title: "teams isn't starting", url: "https://slack/2" },
    ]);
  });

  it("narrows to the source the caller named, by display name with or without #", async () => {
    for (const name of ["#team-snc", "team-snc", "snc-slack-team"]) {
      const http = vi.fn(async () => hits({ id: "C1/2", title: "m", url: "u", updatedAt: "2026-09-21T15:00:00Z" }));
      await recent(http as unknown as typeof fetch).recent(tool, name, READER);
      expect(http).toHaveBeenCalledTimes(1);
      expect(String(http.mock.calls[0]![0])).toContain("/corpora/snc-slack-team/recent");
    }
  });

  // Silently widening to every source would answer a different question.
  it("says so when the named source is not in the knowledge base, without asking anyone", async () => {
    const http = vi.fn();
    const result = await recent(http as unknown as typeof fetch).recent(tool, "#random", READER);

    expect(http).not.toHaveBeenCalled();
    expect(result.result).toContain('"#random" is not a source in SNC');
  });

  it("reports a source that cannot list by time rather than looking complete", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("snc-confluence")
        ? ({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response)
        : hits({ id: "C1/2", title: "m", url: "u", updatedAt: "2026-09-21T15:00:00Z" }),
    );

    const result = await recent(http as unknown as typeof fetch).recent(tool, "", READER);

    expect(result.result).toContain("Could not check: SNC Confluence (cannot list recent items).");
  });

  it("asks for a link only when nothing could be asked at all", async () => {
    const http = vi.fn();
    const result = await recent(http as unknown as typeof fetch, undefined).recent(tool, "", READER);

    expect(http).not.toHaveBeenCalled();
    expect(result.needsLink).toBe(true);
    expect(result.linkProviders).toEqual(["atlassian", "slack"]);
  });
});
