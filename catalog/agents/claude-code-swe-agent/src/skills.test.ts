import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listInstalledSkills, splitSkillInvocation } from "./skills.js";

describe("listInstalledSkills", () => {
  it("lists the skill directories under ~/.claude/skills", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    for (const name of ["implement", "tdd"]) {
      await mkdir(join(homeDir, ".claude/skills", name), { recursive: true });
    }
    await writeFile(join(homeDir, ".claude/skills/README.md"), "not a skill");
    expect((await listInstalledSkills(homeDir)).sort()).toEqual(["implement", "tdd"]);
  });

  it("is empty when nothing was installed", async () => {
    expect(await listInstalledSkills(await mkdtemp(join(tmpdir(), "skills-home-")))).toEqual([]);
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
