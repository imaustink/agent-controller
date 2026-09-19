import { describe, expect, it, vi } from "vitest";
import { KnowledgeBaseSearcher, visibleMembers, type DelegatedCredentialResolver } from "./searcher.js";
import type { KnowledgeBaseExecMember } from "./exec.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { CorpusStore } from "./types.js";

function member(
  id: string,
  allowedRoles: string[],
  collection: string,
  over: Partial<KnowledgeBaseExecMember> = {},
): KnowledgeBaseExecMember {
  return {
    id,
    label: `#${id}`,
    collection,
    allowedRoles,
    granularity: "resource",
    identityProviders: ["atlassian"],
    ...over,
  };
}

function searchTool(...members: KnowledgeBaseExecMember[]): ToolDescriptor {
  return {
    id: "kb:snc/search",
    name: "Search SNC",
    description: "Search the SNC knowledge base.",
    allowedRoles: ["reader"],
    knowledgeBaseExec: {
      knowledgeBaseId: "snc",
      displayName: "SNC",
      operation: "search",
      members,
      disclosePartialVisibility: true,
    },
  };
}

const resolver = (token: string | undefined): DelegatedCredentialResolver & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    async delegatedToken(_subject, providers) {
      asked.push(providers);
      return token;
    },
  };
};

const emptyStore: CorpusStore = { async query() { return []; } };

function searcherWith(
  credentials: DelegatedCredentialResolver,
  openCorpus = vi.fn().mockResolvedValue(emptyStore),
) {
  return {
    openCorpus,
    searcher: new KnowledgeBaseSearcher({
      openCorpus,
      credentials,
      brokerUrl: "http://broker",
      brokerToken: "orch",
    }),
  };
}

const reader = { subject: "openwebui:42", roles: ["reader"] };

describe("KnowledgeBaseSearcher", () => {
  it("fails closed without a resolved identity", async () => {
    const { searcher } = searcherWith(resolver("t"));

    const out = await searcher.search(searchTool(member("c", ["reader"], "coll")), "q", {
      subject: "",
      roles: ["reader"],
    });

    expect(out.result).toContain("could not establish who is asking");
  });

  it("rejects a tool with no execution spec", async () => {
    const { searcher } = searcherWith(resolver("t"));
    const bare: ToolDescriptor = { id: "kb:snc/search", name: "x", description: "y", allowedRoles: [] };

    await expect(searcher.search(bare, "q", reader)).rejects.toThrow(/execution spec/);
  });

  it("does not silently run a search for a non-search operation", async () => {
    const credentials = resolver("t");
    const { searcher, openCorpus } = searcherWith(credentials);
    const tool = searchTool(member("c", ["reader"], "coll"));
    tool.id = "kb:snc/fetch";
    tool.knowledgeBaseExec!.operation = "fetch";

    const out = await searcher.search(tool, "some-source-id", reader);

    // A fetch would need a whole-document source read that is deferred; it must
    // fail closed, never degrade into a similarity search over the source id.
    expect(out.result).toContain("only search is supported");
    expect(out.result).not.toContain("Sources:");
    expect(openCorpus).not.toHaveBeenCalled();
    expect(credentials.asked).toEqual([]);
  });

  it("discloses withheld sources without querying anything", async () => {
    const credentials = resolver("t");
    const { searcher } = searcherWith(credentials);

    const out = await searcher.search(searchTool(member("leads", ["lead"], "coll")), "q", reader);

    expect(out.result).toContain("No passages");
    expect(out.result).toContain("outside your access");
    // Nothing to search, so no credential was needed and none was requested.
    expect(credentials.asked).toEqual([]);
  });

  it("counts an unreconciled member as withheld rather than an empty corpus", async () => {
    const { searcher } = searcherWith(resolver("t"));

    const out = await searcher.search(searchTool(member("fresh", ["reader"], "")), "q", reader);

    expect(out.result).toContain("outside your access");
  });

  it("asks for a link rather than answering unchecked", async () => {
    const { searcher, openCorpus } = searcherWith(resolver(undefined));

    const out = await searcher.search(searchTool(member("c", ["reader"], "coll")), "q", reader);

    expect(out.needsLink).toBe(true);
    expect(out.result).toContain("link the account");
    // No partial answer: probing on the ingestion credential would answer a
    // different question, permissively.
    expect(out.result).not.toContain("Sources:");
    expect(openCorpus).not.toHaveBeenCalled();
  });

  it("asks for the union of its visible members' providers, sorted", async () => {
    const credentials = resolver(undefined);
    const { searcher } = searcherWith(credentials);

    await searcher.search(
      searchTool(
        member("conf", ["reader"], "coll-1"),
        member("drive", ["reader"], "coll-2", { identityProviders: ["google"] }),
      ),
      "q",
      reader,
    );

    expect(credentials.asked).toEqual([["atlassian", "google"]]);
  });

  it("counts a corpus it could not open as missing evidence", async () => {
    const openCorpus = vi.fn().mockResolvedValue(undefined);
    const { searcher } = searcherWith(resolver("t"), openCorpus);

    const out = await searcher.search(searchTool(member("c", ["reader"], "coll")), "q", reader);

    // Unopenable and failed-mid-query are the same gap to the reader.
    expect(out.result).toContain("could not be searched at all");
  });
});

describe("visibleMembers", () => {
  it("separates what may be consulted from what was withheld", () => {
    const { visible, withheld } = visibleMembers(
      [member("a", ["reader"], "c1"), member("b", ["lead"], "c2"), member("c", ["reader"], "")],
      ["reader"],
    );

    expect(visible.map((m) => m.id)).toEqual(["a"]);
    // One by role, one by having nothing indexed yet.
    expect(withheld).toBe(2);
  });

  it("shows nothing to a caller with no roles", () => {
    const { visible, withheld } = visibleMembers([member("a", ["reader"], "c1")], []);
    expect(visible).toEqual([]);
    expect(withheld).toBe(1);
  });
});
