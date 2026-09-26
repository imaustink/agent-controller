import { describe, expect, it } from "vitest";
import { deriveKnowledgeBaseIndex } from "./index-derivation.js";
import type { CorpusDescriptor, KnowledgeBaseDescriptor } from "./types.js";

function connections(): Map<string, CorpusDescriptor> {
  return new Map<string, CorpusDescriptor>([
    [
      "globex-confluence",
      {
        id: "globex-confluence",
        provider: "confluence",
        displayName: "GLOBEX Confluence",
        description: "The GLOBEX space.",
        allowedRoles: ["reader", "writer"],
        collection: "conn_default_globex-confluence",
        apiEnabled: true,
        identityProviders: ["atlassian"],
      },
    ],
    [
      "globex-slack-private",
      {
        id: "globex-slack-private",
        provider: "slack",
        displayName: "#globex-leads",
        description: "Leads-only channel.",
        allowedRoles: ["lead"],
        collection: "conn_default_globex-slack-private",
        apiEnabled: false,
        identityProviders: [],
      },
    ],
  ]);
}

function globexKb(): KnowledgeBaseDescriptor {
  return {
    id: "globex",
    displayName: "GLOBEX",
    description: "The GLOBEX engagement.",
    aliases: [],
    corpusRefs: ["globex-confluence", "globex-slack-private"],
    disclosePartialVisibility: true,
  };
}

describe("deriveKnowledgeBaseIndex", () => {
  it("derives a skill and its tools", () => {
    const { skills, tools } = deriveKnowledgeBaseIndex([globexKb()], connections());

    expect(skills).toHaveLength(1);
    expect(skills[0].skill.id).toBe("kb:globex");
    expect(skills[0].effectiveRoles).toEqual(["lead", "reader", "writer"]);

    expect(tools.map((t) => t.id).sort()).toEqual([
      "kb:globex/read",
      "kb:globex/search",
    ]);
  });

  it("does not generate a fetch tool while fetch has no dispatch path", () => {
    const { tools } = deriveKnowledgeBaseIndex([globexKb()], connections());

    // `/fetch` was a whole-document read with no dispatch path, and offering
    // it steered the planner into a call that silently degraded to a
    // similarity search. `/read` replaced it and DOES dispatch, so the rule is
    // now about the id rather than about there being only one tool.
    expect(tools.map((t) => t.id)).not.toContain("kb:globex/fetch");
    for (const tool of tools) {
      expect(tool.knowledgeBaseExec?.operation ?? "search").not.toBe("fetch");
    }
  });

  it("marks every generated tool hidden", () => {
    const { tools } = deriveKnowledgeBaseIndex([globexKb()], connections());

    // Referenceable by the skill that declares them, never returned by open
    // retrieval — otherwise every client's scoped tooling competes in front of
    // every caller (ADR 0039 §2).
    for (const tool of tools) {
      expect(tool.hidden, tool.id).toBe(true);
    }
  });

  it("gives the read tool the union of the members it can SERVE", () => {
    const { tools } = deriveKnowledgeBaseIndex([globexKb()], connections());

    const get = tools.find((t) => t.id === "kb:globex/read")!;
    // The GET face is one source's capability, not the composition's: granting
    // it the union would let a lead-only caller read a source they hold no role
    // for.
    expect(get.allowedRoles).toEqual(["reader", "writer"]);

    const search = tools.find((t) => t.id === "kb:globex/search")!;
    expect(search.allowedRoles).toEqual(["lead", "reader", "writer"]);
  });

  it("omits a GET tool for a member with no api face", () => {
    const { tools } = deriveKnowledgeBaseIndex([globexKb()], connections());
    expect(tools.find((t) => t.id === "corpus:globex-slack-private/get")).toBeUndefined();
  });

  it("emits one tool record for a connection shared by several knowledge bases", () => {
    const second: KnowledgeBaseDescriptor = {
      ...globexKb(),
      id: "acme",
      displayName: "Acme",
      corpusRefs: ["globex-confluence"],
    };

    const { tools } = deriveKnowledgeBaseIndex([globexKb(), second], connections());

    const gets = tools.filter((t) => t.id === "kb:globex/read");
    expect(gets).toHaveLength(1);
  });

  it("falls closed for a knowledge base whose members all dangle", () => {
    const orphan: KnowledgeBaseDescriptor = { ...globexKb(), corpusRefs: ["gone"] };

    const { skills } = deriveKnowledgeBaseIndex([orphan], connections());

    expect(skills[0].effectiveRoles).toEqual([]);
    // null would mean unrestricted — visible to every resolved identity.
    expect(skills[0].effectiveRoles).not.toBeNull();
  });
});
