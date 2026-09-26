import { describe, expect, it } from "vitest";
import {
  toCorpusDescriptor,
  toKnowledgeBaseDescriptor,
  type CorpusCustomResource,
  type KnowledgeBaseCustomResource,
} from "./crd.js";
import { connectionLabel } from "./types.js";

function connectionCr(
  overrides: Partial<CorpusCustomResource["spec"]> = {},
  status?: CorpusCustomResource["status"],
): CorpusCustomResource {
  return {
    metadata: { name: "snc-slack-eng" },
    spec: {
      connectionRef: "bitovi-slack",
      description: "Engineering channel.",
      displayName: "#snc-eng",
      allowedRoles: ["reader"],
      ...overrides,
    },
    status,
  };
}

function knowledgeBaseCr(
  overrides: Partial<KnowledgeBaseCustomResource["spec"]> = {},
): KnowledgeBaseCustomResource {
  return {
    metadata: { name: "snc" },
    spec: {
      description: "The SNC engagement.",
      corpusRefs: ["snc-confluence"],
      ...overrides,
    },
  };
}

describe("toCorpusDescriptor", () => {
  it("reads the collection off status, not the spec", () => {
    const connection = toCorpusDescriptor(
      connectionCr({ api: { enabled: true } }, { collection: "conn_default_snc-slack-eng" }),
    );

    expect(connection?.collection).toBe("conn_default_snc-slack-eng");
    expect(connection?.apiEnabled).toBe(true);
    expect(connectionLabel(connection!)).toBe("#snc-eng");
  });

  it("decodes an unreconciled connection without a collection", () => {
    const connection = toCorpusDescriptor(connectionCr({ displayName: undefined }));

    // Not searchable until the controller assigns one, but still a valid CR.
    expect(connection?.collection).toBeUndefined();
    expect(connection?.apiEnabled).toBe(false);
    expect(connectionLabel(connection!)).toBe("snc-slack-eng");
  });

  it("rejects a corpus missing its structurally required fields", () => {
    expect(toCorpusDescriptor(connectionCr({ allowedRoles: [] }))).toBeUndefined();
    expect(toCorpusDescriptor(connectionCr({ description: "" }))).toBeUndefined();
  });

  it("reads the provider off STATUS, where the controller resolved it", () => {
    // It lives on the Connection (docs/adr/0043). Copying it into status is
    // what lets this engine read one kind instead of joining two.
    const corpus = toCorpusDescriptor(connectionCr({}, { provider: "slack" }));
    expect(corpus?.provider).toBe("slack");
  });

  it("tolerates a corpus that has not resolved its Connection yet", () => {
    // Applied before its Connection, or no longer resolving one. An ordinary
    // state: it contributes nothing rather than contributing wrongly.
    expect(toCorpusDescriptor(connectionCr())?.provider).toBe("");
  });
});

describe("toKnowledgeBaseDescriptor", () => {
  it("defaults partial-visibility disclosure to on", () => {
    const kb = toKnowledgeBaseDescriptor(knowledgeBaseCr());
    // Silence about withheld sources is the worse default.
    expect(kb?.disclosePartialVisibility).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    const kb = toKnowledgeBaseDescriptor(
      knowledgeBaseCr({ disclosePartialVisibility: false }),
    );
    expect(kb?.disclosePartialVisibility).toBe(false);
  });

  it("defaults identityProviders to empty rather than undefined", () => {
    // Empty means ingestible but not probeable: there is nothing to probe with,
    // and probing with the ingestion credential would answer a different
    // question, permissively (docs/adr/0040).
    expect(toCorpusDescriptor(connectionCr())?.identityProviders).toEqual([]);
  });

  it("carries identity providers through from status", () => {
    const corpus = toCorpusDescriptor(
      connectionCr({}, { provider: "confluence", identityProviders: ["atlassian"] }),
    );
    expect(corpus?.identityProviders).toEqual(["atlassian"]);
  });
});

describe("toKnowledgeBaseDescriptor", () => {
  it("defaults aliases to empty rather than undefined", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr())?.aliases).toEqual([]);
  });

  it("rejects a knowledge base composing nothing", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr({ corpusRefs: [] }))).toBeUndefined();
  });

  it("rejects a knowledge base with no description to discriminate on", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr({ description: "" }))).toBeUndefined();
  });
});
