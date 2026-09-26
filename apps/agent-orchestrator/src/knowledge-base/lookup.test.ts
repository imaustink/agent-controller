import { describe, expect, it, vi } from "vitest";
import { CorpusLookup } from "./lookup.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool = {
  id: "kb:globex/lookup",
  name: "Look up in GLOBEX",
  description: "…",
  allowedRoles: ["reader", "lead"],
  knowledgeBaseExec: {
    knowledgeBaseId: "globex",
    displayName: "GLOBEX",
    operation: "lookup",
    members: [
      {
        id: "globex-confluence",
        label: "GLOBEX Confluence",
        collection: "c1",
        allowedRoles: ["reader"],
        identityProviders: ["atlassian"],
      },
      {
        id: "globex-leads",
        label: "#globex-leads",
        collection: "c2",
        allowedRoles: ["lead"],
        identityProviders: ["slack"],
      },
    ],
    disclosePartialVisibility: true,
  },
} as unknown as ToolDescriptor;

const READER = { subject: "openwebui:42", roles: ["reader"] };
const BOTH = { subject: "openwebui:42", roles: ["reader", "lead"] };

// No default parameter for the credential: `lookup(http, undefined)` must mean
// "nothing linked", and a default would silently turn that into the happy path.
function lookup(fetchImpl: typeof fetch, ...credential: [{ token: string } | undefined] | []) {
  const resolved = credential.length === 0 ? { token: "user-token" } : credential[0];
  return new CorpusLookup({
    brokerUrl: "http://broker.test/",
    brokerToken: "orchestrator-secret",
    credentials: { delegatedToken: vi.fn().mockResolvedValue(resolved) },
    fetchImpl,
  });
}

const hits = (...items: Record<string, string>[]) =>
  ({ ok: true, status: 200, json: async () => ({ hits: items }), text: async () => "" }) as Response;

const status = (code: number) =>
  ({ ok: false, status: code, json: async () => ({}), text: async () => "" }) as Response;

describe("lookup", () => {
  it("asks every member the caller may reach, and cites readable references", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("globex-confluence")
        ? hits({ id: "123", title: "Runbook", url: "https://wiki/123", excerpt: "deploy steps" })
        : hits({ id: "C1/1.1", title: "thread", url: "https://slack/1" }),
    );

    const result = await lookup(http as unknown as typeof fetch).lookup(tool, "deploy", BOTH);

    // A knowledge base is a composition: the question goes to all of it.
    expect(http).toHaveBeenCalledTimes(2);
    // The reference is exactly what the READ tool takes — that pairing is the
    // point, so the model never has to assemble one.
    expect(result.result).toContain("reference: globex-confluence/123");
    expect(result.result).toContain("reference: globex-leads/C1/1.1");
  });

  it("carries the caller's token and the corpus scope to the broker", async () => {
    const http = vi.fn(async () => hits({ id: "1", title: "t", url: "u" }));

    await lookup(http as unknown as typeof fetch).lookup(tool, "deploy runbook", READER);

    expect(http.mock.calls[0]![0]).toBe(
      "http://broker.test/corpora/globex-confluence/search?q=deploy%20runbook",
    );
    expect((http.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer orchestrator-secret",
      "x-delegated-token": "user-token",
    });
  });

  it("skips a member the caller holds no role for", async () => {
    // Union to invoke, per member to search. OUR policy layer, which is not the
    // same question as the source's.
    const http = vi.fn(async () => hits({ id: "1", title: "t", url: "u" }));

    await lookup(http as unknown as typeof fetch).lookup(tool, "salary", READER);

    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]![0])).toContain("globex-confluence");
  });

  it("reports what it could not search rather than looking complete", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("globex-confluence")
        ? hits({ id: "1", title: "Found", url: "u" })
        : status(404),
    );

    const result = await lookup(http as unknown as typeof fetch).lookup(tool, "deploy", BOTH);

    expect(result.result).toContain("Found");
    // A partial answer the caller believes is complete is worse than one that
    // says what it could not reach.
    expect(result.result).toContain("Could not search");
    expect(result.result).toContain("no live search");
  });

  it("asks for a link only when NOTHING could be searched", async () => {
    const http = vi.fn();
    const result = await lookup(http as unknown as typeof fetch, undefined).lookup(
      tool,
      "deploy",
      READER,
    );

    expect(result.needsLink).toBe(true);
    expect(result.result).toContain("link the account");
    expect(http).not.toHaveBeenCalled();
  });

  it("does not interrupt a turn that partly succeeded", async () => {
    // One member answered, so asking for a link would interrupt a turn that
    // worked. The gap goes in the prose instead.
    const http = vi.fn(async () => hits({ id: "1", title: "Found", url: "u" }));
    const reader = new CorpusLookup({
      brokerUrl: "http://broker.test/",
      brokerToken: "orchestrator-secret",
      credentials: {
        delegatedToken: vi.fn(async (_subject: string, providers: string[]) =>
          providers.includes("atlassian") ? { token: "user-token" } : undefined,
        ),
      },
      fetchImpl: http as unknown as typeof fetch,
    });

    const result = await reader.lookup(tool, "deploy", BOTH);

    expect(result.needsLink).toBeUndefined();
    expect(result.result).toContain("Found");
    expect(result.result).toContain("Not searched (no linked account)");
  });

  it("says so plainly when there are no matches", async () => {
    const http = vi.fn(async () => hits());
    const result = await lookup(http as unknown as typeof fetch).lookup(tool, "nonexistent", READER);
    expect(result.result).toContain("Nothing in GLOBEX matches");
  });

  it("returns nothing for an empty query rather than searching for nothing", async () => {
    const http = vi.fn();
    const result = await lookup(http as unknown as typeof fetch).lookup(tool, "   ", READER);

    expect(result.result).toContain("something to look for");
    expect(http).not.toHaveBeenCalled();
  });

  it("raises when the broker cannot be reached at all", async () => {
    // Distinct from a refusal: we did not get an answer, and reporting one
    // would be inventing it.
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      lookup(http as unknown as typeof fetch).lookup(tool, "deploy", READER),
    ).rejects.toThrow(/unreachable/);
  });

  it("refuses a tool that is not a knowledge-base lookup", async () => {
    const bare = { ...tool, knowledgeBaseExec: undefined } as unknown as ToolDescriptor;
    await expect(
      lookup(vi.fn() as unknown as typeof fetch).lookup(bare, "q", READER),
    ).rejects.toThrow(/not a knowledge-base lookup/);
  });
});
