import { describe, expect, it, vi } from "vitest";
import { deriveSkillAccess } from "./derive-access.js";
import type { SkillDescriptor } from "./types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { AgentDescriptor } from "../agents/types.js";

function tool(id: string, allowedRoles: string[], allowedPrincipals?: string[]): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    allowedRoles,
    ...(allowedPrincipals ? { allowedPrincipals } : {}),
    jobTemplate: { image: `example.com/${id}:latest`, namespace: "default", serviceAccountName: "sa" },
  };
}

function agent(id: string, allowedRoles: string[], allowedPrincipals?: string[]): AgentDescriptor {
  return {
    id,
    name: id,
    description: `Agent ${id}`,
    allowedRoles,
    ...(allowedPrincipals ? { allowedPrincipals } : {}),
    agentRunTemplate: { namespace: "default", agentRef: id },
  };
}

function skill(id: string, toolIds: string[], agentIds: string[] = [], allowedPrincipals?: string[]): SkillDescriptor {
  return {
    id,
    name: id,
    description: `Skill ${id}`,
    markdown: "# instructions",
    toolIds,
    agentIds,
    ...(allowedPrincipals ? { allowedPrincipals } : {}),
  };
}

describe("deriveSkillAccess (ADR 0011, extended to agents by ADR 0021)", () => {
  it("derives a skill's audience as the intersection of its tools' allowedRoles", () => {
    const access = deriveSkillAccess(
      [skill("recipe-skill", ["scraper", "publisher"])],
      [tool("scraper", ["reader", "writer"]), tool("publisher", ["reader", "admin"])],
      [],
    );

    expect(access).toEqual([
      { skill: skill("recipe-skill", ["scraper", "publisher"]), effectiveRoles: ["reader"], effectivePrincipals: null },
    ]);
  });

  it("marks a tool-less and agent-less (respond-only) skill as unrestricted via effectiveRoles: null", () => {
    const access = deriveSkillAccess([skill("faq-skill", [])], [tool("scraper", ["reader"])], []);

    expect(access[0].effectiveRoles).toBeNull();
  });

  it("fails closed (effectiveRoles: []) when a referenced tool is not in the catalog", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const access = deriveSkillAccess(
        [skill("broken-skill", ["scraper", "ghost-tool"])],
        [tool("scraper", ["reader"])],
        [],
      );

      expect(access[0].effectiveRoles).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"ghost-tool"'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("yields an empty audience (and warns) when the tools' allowedRoles are disjoint", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const access = deriveSkillAccess(
        [skill("mixed-skill", ["scraper", "admin-tool"])],
        [tool("scraper", ["reader"]), tool("admin-tool", ["admin"])],
        [],
      );

      expect(access[0].effectiveRoles).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("mixed-skill"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("derives independently per skill", () => {
    const access = deriveSkillAccess([skill("a", ["scraper"]), skill("b", [])], [tool("scraper", ["reader"])], []);

    expect(access.map((a) => a.effectiveRoles)).toEqual([["reader"], null]);
  });

  it("derives a skill's audience as the intersection of its agents' allowedRoles when it has only agentIds", () => {
    const access = deriveSkillAccess(
      [skill("swe-skill", [], ["opencode-swe-agent"])],
      [],
      [agent("opencode-swe-agent", ["writer"])],
    );

    expect(access[0].effectiveRoles).toEqual(["writer"]);
  });

  it("intersects across both tools and agents when a skill declares both", () => {
    const access = deriveSkillAccess(
      [skill("mixed-skill", ["scraper"], ["opencode-swe-agent"])],
      [tool("scraper", ["reader", "writer"])],
      [agent("opencode-swe-agent", ["writer", "admin"])],
    );

    expect(access[0].effectiveRoles).toEqual(["writer"]);
  });

  it("fails closed (effectiveRoles: []) when a referenced agent is not in the catalog", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const access = deriveSkillAccess([skill("broken-skill", [], ["ghost-agent"])], [], []);

      expect(access[0].effectiveRoles).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"ghost-agent"'));
    } finally {
      consoleError.mockRestore();
    }
  });

  // ── ABAC private-scoping (docs/adr/0036) ──────────────────────────────────

  it("leaves effectivePrincipals null when neither the skill nor any tool/agent is private", () => {
    const access = deriveSkillAccess([skill("s", ["scraper"])], [tool("scraper", ["reader"])], []);
    expect(access[0].effectivePrincipals).toBeNull();
  });

  it("inherits a private tool's allowedPrincipals so a skill never widens its audience", () => {
    const access = deriveSkillAccess(
      [skill("s", ["scraper"])],
      [tool("scraper", ["reader"], ["github:owner"])],
      [],
    );
    expect(access[0].effectivePrincipals).toEqual(["github:owner"]);
  });

  it("intersects the skill's own allowedPrincipals with a referenced private tool's", () => {
    const access = deriveSkillAccess(
      [skill("s", ["scraper"], [], ["github:owner", "github:teammate"])],
      [tool("scraper", ["reader"], ["github:owner"])],
      [],
    );
    expect(access[0].effectivePrincipals).toEqual(["github:owner"]);
  });

  it("ignores public tools/agents when deriving principals (they add no constraint)", () => {
    const access = deriveSkillAccess(
      [skill("s", ["scraper", "publisher"])],
      [tool("scraper", ["reader"], ["github:owner"]), tool("publisher", ["reader"])],
      [],
    );
    expect(access[0].effectivePrincipals).toEqual(["github:owner"]);
  });

  it("scopes a respond-only skill to its OWN allowedPrincipals even with no tools/agents", () => {
    const access = deriveSkillAccess([skill("private-faq", [], [], ["github:owner"])], [], []);
    expect(access[0].effectiveRoles).toBeNull(); // RBAC-unrestricted
    expect(access[0].effectivePrincipals).toEqual(["github:owner"]); // ABAC-private
  });

  it("yields an empty (unreachable) principal set and warns when private sets are disjoint", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const access = deriveSkillAccess(
        [skill("s", ["a", "b"])],
        [tool("a", ["reader"], ["github:alice"]), tool("b", ["reader"], ["github:bob"])],
        [],
      );
      expect(access[0].effectivePrincipals).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("privately scoped to no one"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("intersects private-scoping across both a tool and an agent", () => {
    const access = deriveSkillAccess(
      [skill("s", ["scraper"], ["swe"])],
      [tool("scraper", ["reader", "writer"], ["github:owner", "github:teammate"])],
      [agent("swe", ["writer"], ["github:owner"])],
    );
    expect(access[0].effectivePrincipals).toEqual(["github:owner"]);
  });
});
