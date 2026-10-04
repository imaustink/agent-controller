import { describe, expect, it, vi } from "vitest";
import { CorpusQuery } from "./query.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool = {
  id: "kb:snc/query",
  name: "Query SNC",
  description: "…",
  allowedRoles: ["reader"],
  knowledgeBaseExec: {
    knowledgeBaseId: "snc",
    displayName: "SNC",
    operation: "query",
    members: [
      { id: "snc-slack-team", label: "#team-snc", collection: "c1", allowedRoles: ["reader"], identityProviders: ["slack"] },
      { id: "snc-confluence", label: "SNC Confluence", collection: "c2", allowedRoles: ["reader"], identityProviders: ["atlassian"] },
    ],
    disclosePartialVisibility: true,
  },
} as unknown as ToolDescriptor;

const READER = { subject: "openwebui:42", roles: ["reader"] };

// No default parameter for the token: `client(http, undefined)` must mean
// "nothing linked", and a default would silently turn that into the happy path.
function client(fetchImpl: typeof fetch, ...token: [string | undefined] | []) {
  const resolved = token.length === 0 ? "user-token" : token[0];
  return new CorpusQuery({
    brokerUrl: "http://broker.test/",
    brokerToken: "orchestrator-secret",
    credentials: {
      delegatedToken: vi.fn().mockResolvedValue(resolved ? { token: resolved } : undefined),
      delegatedTokens: vi.fn().mockResolvedValue(new Map()),
    },
    fetchImpl,
  });
}

const reply = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;
const hits = (...items: Record<string, string>[]) => reply({ hits: items });

/** A broker that answers per corpus and records the filter each was sent. */
function broker(byCorpus: Record<string, Response>) {
  const asked: { corpus: string; body: Record<string, unknown> }[] = [];
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    const corpus = decodeURIComponent(url.split("/corpora/")[1]!.split("/")[0]!);
    asked.push({ corpus, body: JSON.parse(String(init?.body)) });
    expect(init?.method).toBe("POST");
    return byCorpus[corpus] ?? ({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response);
  });
  return { http: http as unknown as typeof fetch, asked };
}

// PARITY: corpus_query_test.go.
describe("CorpusQuery", () => {
  it("sends the structured filter to each source, with the defaults applied", async () => {
    const { http, asked } = broker({ "snc-slack-team": hits(), "snc-confluence": hits() });

    await client(http).query(tool, '{"author":"Brad","after":"2026-09-01","before":"2026-10-01","type":"page"}', READER);

    expect(asked).toHaveLength(2);
    expect(asked[0]!.body).toEqual({
      author: "Brad", after: "2026-09-01", before: "2026-10-01", type: "page", sort: "newest", limit: 10,
    });
  });

  it("takes plain words as keywords, ranked by relevance", async () => {
    const { http, asked } = broker({ "snc-slack-team": hits(), "snc-confluence": hits() });

    await client(http).query(tool, "retro action items", READER);

    expect(asked[0]!.body).toMatchObject({ text: "retro action items", sort: "relevance" });
  });

  it("merges a time sort across sources and numbers from the turn's next citation", async () => {
    const { http } = broker({
      "snc-slack-team": hits({ id: "C1/2", title: "teams isn't starting", url: "https://slack/2", updatedAt: "2026-09-21T15:00:00Z" }),
      "snc-confluence": hits({ id: "p1", title: "Monthly Prep", url: "https://wiki/p1", updatedAt: "2026-09-22T09:00:00Z" }),
    });

    const result = await client(http).query(tool, '{"sort":"newest"}', READER, 4);

    expect(result.result.indexOf("[4] Monthly Prep")).toBeGreaterThan(-1);
    expect(result.result.indexOf("[4] Monthly Prep")).toBeLessThan(result.result.indexOf("[5] teams isn't starting"));
    expect(result.result).toContain("reference: snc-confluence/p1");
    expect(result.sources).toEqual([
      { n: 4, title: "Monthly Prep", url: "https://wiki/p1" },
      { n: 5, title: "teams isn't starting", url: "https://slack/2" },
    ]);
  });

  it("interleaves relevance across sources rather than ranking incomparable scores", async () => {
    const { http } = broker({
      "snc-slack-team": hits({ id: "s1", title: "slack best", url: "u1" }, { id: "s2", title: "slack second", url: "u2" }),
      "snc-confluence": hits({ id: "w1", title: "wiki best", url: "u3" }),
    });

    const result = await client(http).query(tool, '{"text":"retro"}', READER);

    expect(result.sources!.map((s) => s.title)).toEqual(["slack best", "wiki best", "slack second"]);
  });

  it("reports a filter a source cannot apply, never showing its results as matches", async () => {
    const { http } = broker({
      "snc-slack-team": reply({ hits: [], unsupported: ["title"] }),
      "snc-confluence": hits({ id: "p1", title: "Retro", url: "u", updatedAt: "2026-09-22T09:00:00Z" }),
    });

    const result = await client(http).query(tool, '{"title":"retro"}', READER);

    expect(result.result).toContain("Could not query: #team-snc (cannot filter by title).");
    expect(result.sources).toHaveLength(1);
  });

  it("narrows to the named source, by display name with or without #", async () => {
    for (const name of ["#team-snc", "team-snc", "snc-slack-team"]) {
      const { http, asked } = broker({ "snc-slack-team": hits() });
      await client(http).query(tool, JSON.stringify({ source: name }), READER);
      expect(asked.map((a) => a.corpus)).toEqual(["snc-slack-team"]);
      expect(asked[0]!.body).not.toHaveProperty("source");
    }
  });

  it.each([
    ['{"after":"last week"}', "use YYYY-MM-DD"],
    ['{"sort":"popular"}', "not a sort"],
    ['{"when":"recently"}', "not usable"],
    ['{"limit":"five"}', "not usable"],
    ['{"source":"#random"}', '"#random" is not a source in SNC'],
    ['{"text": "unterminated', "not usable"],
  ])("explains an unusable filter %s without asking anyone", async (input, want) => {
    const { http, asked } = broker({});
    const result = await client(http).query(tool, input, READER);
    expect(result.result).toContain(want);
    expect(asked).toHaveLength(0);
  });

  it("asks for a link only when nothing could be asked at all", async () => {
    const { http, asked } = broker({});
    const result = await client(http, undefined).query(tool, "{}", READER);

    expect(asked).toHaveLength(0);
    expect(result.needsLink).toBe(true);
    expect(result.linkProviders).toEqual(["atlassian", "slack"]);
  });
});
