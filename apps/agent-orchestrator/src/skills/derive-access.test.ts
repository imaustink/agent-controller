import { describe, expect, it, vi } from "vitest";
import { deriveSkillAccess } from "./derive-access.js";
import type { SkillDescriptor } from "./types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { AgentDescriptor } from "../agents/types.js";

function tool(id: string, allowedRoles: string[]): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    allowedRoles,
    jobTemplate: { image: `example.com/${id}:latest`, namespace: "default", serviceAccountName: "sa" },
  };
}

function agent(id: string, allowedRoles: string[]): AgentDescriptor {
  return {
    id,
    name: id,
    description: `Agent ${id}`,
    allowedRoles,
    agentRunTemplate: { namespace: "default", agentRef: id },
  };
}

function skill(id: string, toolIds: string[], agentIds: string[] = []): SkillDescriptor {
  return { id, name: id, description: `Skill ${id}`, markdown: "# instructions", toolIds, agentIds };
}

describe("deriveSkillAccess (ADR 0011, extended to agents by ADR 0021)", () => {
  it("derives a skill's audience as the intersection of its tools' allowedRoles", () => {
    const access = deriveSkillAccess(
      [skill("recipe-skill", ["scraper", "publisher"])],
      [tool("scraper", ["reader", "writer"]), tool("publisher", ["reader", "admin"])],
      [],
    );

    expect(access).toEqual([
      { skill: skill("recipe-skill", ["scraper", "publisher"]), effectiveRoles: ["reader"] },
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
});
