import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copies the selected Claude Code skills from the image's read-only bundle
 * (`CLAUDE_SKILLS_DIR`, baked in by the Dockerfile at a pinned upstream
 * commit) into `$HOME/.claude/skills`, where the CLI discovers user-level
 * skills. Copied rather than symlinked: the files are tiny and a copy can't
 * be tripped up by how the CLI resolves links.
 *
 * Throws on a name that isn't in the bundle -- a typo in the Helm value
 * should fail the run loudly, not silently run without the skill.
 */
export async function installSkills(opts: { sourceDir: string; homeDir: string; names: string[] }): Promise<string[]> {
  if (opts.names.length === 0) return [];
  let available: string[];
  try {
    available = await readdir(opts.sourceDir);
  } catch {
    throw new Error(`CLAUDE_SKILLS is set but the skills bundle ${opts.sourceDir} is missing from this image`);
  }
  const unknown = opts.names.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown Claude Code skill(s) in CLAUDE_SKILLS: ${unknown.join(", ")} (available: ${available.sort().join(", ")})`,
    );
  }
  const skillsDir = join(opts.homeDir, ".claude", "skills");
  for (const name of opts.names) {
    await cp(join(opts.sourceDir, name), join(skillsDir, name), { recursive: true });
  }
  return opts.names;
}

/**
 * Splits a leading `/<skill>` invocation off the caller's instruction when it
 * names an installed skill. The CLI only expands a slash command at the very
 * start of the prompt -- confirmed empirically on the pinned CLI: the same
 * `/skill` under buildPrompt's `## Task` heading is plain text, and a skill
 * with `disable-model-invocation: true` (e.g. `implement`) then can't be
 * reached at all. Anything else -- no slash, or a slash naming something not
 * installed (a path, a typo) -- is left untouched.
 */
export function splitSkillInvocation(
  instruction: string,
  installed: readonly string[],
): { skill: string | null; instruction: string } {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+|$)/.exec(instruction.trimStart());
  const skill = match?.[1];
  if (!match || !skill || !installed.includes(skill)) return { skill: null, instruction };
  return { skill, instruction: instruction.trimStart().slice(match[0].length) };
}
