import { describe, expect, it, vi } from "vitest";
import { deriveSkillAccess } from "./derive-access.js";
import type { SkillDescriptor } from "./types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

function tool(id: string, allowedRoles: string[]): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    allowedRoles,
    jobTemplate: { image: `example.com/${id}:latest`, namespace: "default", serviceAccountName: "sa" },
  };
}

function skill(id: string, toolIds: string[]): SkillDescriptor {
  return { id, name: id, description: `Skill ${id}`, markdown: "# instructions", toolIds };
}

describe("deriveSkillAccess (ADR 0011)", () => {
  it("derives a skill's audience as the intersection of its tools' allowedRoles", () => {
    const access = deriveSkillAccess(
      [skill("recipe-skill", ["scraper", "publisher"])],
      [tool("scraper", ["reader", "writer"]), tool("publisher", ["reader", "admin"])],
    );

    expect(access).toEqual([{ skill: skill("recipe-skill", ["scraper", "publisher"]), effectiveRoles: ["reader"] }]);
  });

  it("marks a tool-less (respond-only) skill as unrestricted via effectiveRoles: null", () => {
    const access = deriveSkillAccess([skill("faq-skill", [])], [tool("scraper", ["reader"])]);

    expect(access[0].effectiveRoles).toBeNull();
  });

  it("fails closed (effectiveRoles: []) when a referenced tool is not in the catalog", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const access = deriveSkillAccess([skill("broken-skill", ["scraper", "ghost-tool"])], [tool("scraper", ["reader"])]);

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
      );

      expect(access[0].effectiveRoles).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("mixed-skill"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("derives independently per skill", () => {
    const access = deriveSkillAccess(
      [skill("a", ["scraper"]), skill("b", [])],
      [tool("scraper", ["reader"])],
    );

    expect(access.map((a) => a.effectiveRoles)).toEqual([["reader"], null]);
  });
});
