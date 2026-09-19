import { describe, expect, it } from "vitest";
import {
  toConnectionDescriptor,
  toKnowledgeBaseDescriptor,
  type ConnectionCustomResource,
  type KnowledgeBaseCustomResource,
} from "./crd.js";
import { connectionLabel } from "./types.js";

function connectionCr(
  overrides: Partial<ConnectionCustomResource["spec"]> = {},
  status?: ConnectionCustomResource["status"],
): ConnectionCustomResource {
  return {
    metadata: { name: "snc-slack-eng" },
    spec: {
      provider: "slack",
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
      connectionRefs: ["snc-confluence"],
      ...overrides,
    },
  };
}

describe("toConnectionDescriptor", () => {
  it("reads the collection off status, not the spec", () => {
    const connection = toConnectionDescriptor(
      connectionCr({ api: { enabled: true } }, { collection: "conn_default_snc-slack-eng" }),
    );

    expect(connection?.collection).toBe("conn_default_snc-slack-eng");
    expect(connection?.apiEnabled).toBe(true);
    expect(connectionLabel(connection!)).toBe("#snc-eng");
  });

  it("decodes an unreconciled connection without a collection", () => {
    const connection = toConnectionDescriptor(connectionCr({ displayName: undefined }));

    // Not searchable until the controller assigns one, but still a valid CR.
    expect(connection?.collection).toBeUndefined();
    expect(connection?.apiEnabled).toBe(false);
    expect(connectionLabel(connection!)).toBe("snc-slack-eng");
  });

  it("rejects a connection missing its structurally required fields", () => {
    expect(toConnectionDescriptor(connectionCr({ allowedRoles: [] }))).toBeUndefined();
    expect(toConnectionDescriptor(connectionCr({ provider: "" }))).toBeUndefined();
    expect(toConnectionDescriptor(connectionCr({ description: "" }))).toBeUndefined();
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
    expect(toConnectionDescriptor(connectionCr())?.identityProviders).toEqual([]);
  });

  it("carries declared identity providers through", () => {
    const connection = toConnectionDescriptor(connectionCr({ identityProviders: ["atlassian"] }));
    expect(connection?.identityProviders).toEqual(["atlassian"]);
  });
});

describe("toKnowledgeBaseDescriptor", () => {
  it("defaults aliases to empty rather than undefined", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr())?.aliases).toEqual([]);
  });

  it("rejects a knowledge base composing nothing", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr({ connectionRefs: [] }))).toBeUndefined();
  });

  it("rejects a knowledge base with no description to discriminate on", () => {
    expect(toKnowledgeBaseDescriptor(knowledgeBaseCr({ description: "" }))).toBeUndefined();
  });
});
