import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Names of the Claude Code skills installed under `$HOME/.claude/skills`.
 * They're put there before this process starts, by the Agent CR's
 * `install-claude-skills` init container (see the community-components
 * chart's `claudeCodeSweAgent.skills`); a missing directory just means none.
 */
export async function listInstalledSkills(homeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(homeDir, ".claude", "skills"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
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
