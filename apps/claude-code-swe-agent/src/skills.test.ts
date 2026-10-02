import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkills, splitSkillInvocation } from "./skills.js";

async function bundle(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skills-bundle-"));
  for (const name of names) {
    await mkdir(join(dir, name, "agents"), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    await writeFile(join(dir, name, "agents", "extra.md"), "nested");
  }
  return dir;
}

describe("installSkills", () => {
  it("copies only the selected skills, nested files included", async () => {
    const sourceDir = await bundle(["implement", "tdd", "wizard"]);
    const homeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    expect(await installSkills({ sourceDir, homeDir, names: ["implement", "tdd"] })).toEqual(["implement", "tdd"]);
    expect(await readFile(join(homeDir, ".claude/skills/implement/SKILL.md"), "utf8")).toContain("name: implement");
    expect(await readFile(join(homeDir, ".claude/skills/tdd/agents/extra.md"), "utf8")).toBe("nested");
    await expect(readFile(join(homeDir, ".claude/skills/wizard/SKILL.md"))).rejects.toThrow();
  });

  it("rejects a name that isn't in the bundle", async () => {
    const sourceDir = await bundle(["implement"]);
    const homeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    await expect(installSkills({ sourceDir, homeDir, names: ["implment"] })).rejects.toThrow(/implment.*available: implement/);
  });

  it("is a no-op with nothing selected, even without a bundle", async () => {
    expect(await installSkills({ sourceDir: "/nonexistent", homeDir: "/nonexistent", names: [] })).toEqual([]);
  });

  it("fails clearly when skills are selected but the bundle is missing", async () => {
    await expect(installSkills({ sourceDir: "/nonexistent", homeDir: "/tmp", names: ["implement"] })).rejects.toThrow(
      /bundle \/nonexistent is missing/,
    );
  });
});

describe("splitSkillInvocation", () => {
  const installed = ["implement", "tdd"];

  it("splits a leading installed skill off the instruction", () => {
    expect(splitSkillInvocation("/implement the spec in #42\nand more", installed)).toEqual({
      skill: "implement",
      instruction: "the spec in #42\nand more",
    });
  });

  it("tolerates leading whitespace and a bare invocation", () => {
    expect(splitSkillInvocation("  /tdd", installed)).toEqual({ skill: "tdd", instruction: "" });
  });

  it("leaves skills that aren't installed, paths, and mid-text slashes alone", () => {
    for (const text of ["/wizard do it", "/etc/hosts is wrong", "/implementation notes", "please /implement this"]) {
      expect(splitSkillInvocation(text, installed)).toEqual({ skill: null, instruction: text });
    }
  });
});
