import { describe, expect, it } from "vitest";
import { deriveKnowledgeBaseIndex } from "./index-derivation.js";
import type { ConnectionDescriptor, KnowledgeBaseDescriptor } from "./types.js";

function connections(): Map<string, ConnectionDescriptor> {
  return new Map<string, ConnectionDescriptor>([
    [
      "snc-confluence",
      {
        id: "snc-confluence",
        provider: "confluence",
        displayName: "SNC Confluence",
        description: "The SNC space.",
        allowedRoles: ["reader", "writer"],
        collection: "conn_default_snc-confluence",
        apiEnabled: true,
        identityProviders: ["atlassian"],
      },
    ],
    [
      "snc-slack-private",
      {
        id: "snc-slack-private",
        provider: "slack",
        displayName: "#snc-leads",
        description: "Leads-only channel.",
        allowedRoles: ["lead"],
        collection: "conn_default_snc-slack-private",
        apiEnabled: false,
        identityProviders: [],
      },
    ],
  ]);
}

function sncKb(): KnowledgeBaseDescriptor {
  return {
    id: "snc",
    displayName: "SNC",
    description: "The SNC engagement.",
    aliases: [],
    connectionRefs: ["snc-confluence", "snc-slack-private"],
    disclosePartialVisibility: true,
  };
}

describe("deriveKnowledgeBaseIndex", () => {
  it("derives a skill and its tools", () => {
    const { skills, tools } = deriveKnowledgeBaseIndex([sncKb()], connections());

    expect(skills).toHaveLength(1);
    expect(skills[0].skill.id).toBe("kb:snc");
    expect(skills[0].effectiveRoles).toEqual(["lead", "reader", "writer"]);

    expect(tools.map((t) => t.id).sort()).toEqual([
      "conn:snc-confluence/get",
      "kb:snc/fetch",
      "kb:snc/search",
    ]);
  });

  it("marks every generated tool hidden", () => {
    const { tools } = deriveKnowledgeBaseIndex([sncKb()], connections());

    // Referenceable by the skill that declares them, never returned by open
    // retrieval — otherwise every client's scoped tooling competes in front of
    // every caller (ADR 0039 §2).
    for (const tool of tools) {
      expect(tool.hidden, tool.id).toBe(true);
    }
  });

  it("gives a connection's GET tool its own roles, not the union", () => {
    const { tools } = deriveKnowledgeBaseIndex([sncKb()], connections());

    const get = tools.find((t) => t.id === "conn:snc-confluence/get")!;
    // The GET face is one source's capability, not the composition's: granting
    // it the union would let a lead-only caller read a source they hold no role
    // for.
    expect(get.allowedRoles).toEqual(["reader", "writer"]);

    const search = tools.find((t) => t.id === "kb:snc/search")!;
    expect(search.allowedRoles).toEqual(["lead", "reader", "writer"]);
  });

  it("omits a GET tool for a member with no api face", () => {
    const { tools } = deriveKnowledgeBaseIndex([sncKb()], connections());
    expect(tools.find((t) => t.id === "conn:snc-slack-private/get")).toBeUndefined();
  });

  it("emits one tool record for a connection shared by several knowledge bases", () => {
    const second: KnowledgeBaseDescriptor = {
      ...sncKb(),
      id: "acme",
      displayName: "Acme",
      connectionRefs: ["snc-confluence"],
    };

    const { tools } = deriveKnowledgeBaseIndex([sncKb(), second], connections());

    const gets = tools.filter((t) => t.id === "conn:snc-confluence/get");
    expect(gets).toHaveLength(1);
  });

  it("falls closed for a knowledge base whose members all dangle", () => {
    const orphan: KnowledgeBaseDescriptor = { ...sncKb(), connectionRefs: ["gone"] };

    const { skills } = deriveKnowledgeBaseIndex([orphan], connections());

    expect(skills[0].effectiveRoles).toEqual([]);
    // null would mean unrestricted — visible to every resolved identity.
    expect(skills[0].effectiveRoles).not.toBeNull();
  });
});
