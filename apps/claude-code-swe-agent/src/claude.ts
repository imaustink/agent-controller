import type { SweMarker } from "./marker.js";

/**
 * Guardrails baked into every invocation, as `permissions.deny` rules in the
 * generated Claude Code settings JSON (see {@link buildClaudeSettings}).
 * Claude Code's permission rules take the form `Tool(prefix:*)` and an
 * explicit `deny` entry is enforced regardless of `--permission-mode`
 * (confirmed against `claude -p --help`'s own `--allowedTools`/
 * `--disallowedTools` examples, e.g. `"Bash(git *) Edit"`), so this is the
 * reliable lever for "no irreversible actions" even though this agent runs
 * fully non-interactively (`--permission-mode bypassPermissions`). It is
 * intentionally NOT configurable by the caller. Defense-in-depth: the GitHub
 * App's permissions and server-side branch/repo protection rules are the
 * other layers (see docs/security.md).
 */
export const DENY_BASH_PATTERNS: string[] = [
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push --force-with-lease:*)",
  "Bash(git push --force-if-includes:*)",
  "Bash(git reset --hard:*)",
  "Bash(git branch -D:*)",
  "Bash(git update-ref -d:*)",
  "Bash(rm -rf:*)",
  "Bash(gh repo delete:*)",
  "Bash(gh api -X DELETE:*)",
  "Bash(gh api --method DELETE:*)",
];

/**
 * Builds the `--settings` JSON handed to `claude -p`. Non-negotiable
 * `permissions.deny` bash guardrails plus, since this agent runs headless
 * with nobody to answer a permission prompt, `bypassPermissions` is also set
 * here (in addition to being passed as `--permission-mode` — belt and
 * braces, matching how CLI flags and settings.json can each independently
 * express the same setting).
 *
 * NOTE for Remote Control (`--bg`, see claude-runner.ts's
 * `runClaudeTurnRemoteControlled`): `claude --bg` combined with
 * `bypassPermissions` separately requires
 * `skipDangerousModePermissionPrompt: true` in the REAL on-disk
 * `~/.claude/settings.json` file -- confirmed empirically that passing it
 * via `--settings` here (as this function's return value is passed) does
 * NOT satisfy that check, only the literal file does. That's written
 * directly by `index.ts`'s handler, not here -- see its comment for why.
 */
export function buildClaudeSettings(): object {
  return {
    permissions: {
      defaultMode: "bypassPermissions",
      deny: DENY_BASH_PATTERNS,
    },
  };
}

/**
 * The task prompt handed to Claude Code. The user's instruction is embedded
 * as data; the surrounding text is fixed, trusted policy (the git workflow
 * and the "never destructive" rules). On a continuation turn the marker pins
 * the repo/branch/PR so Claude Code resumes the same work (this agent has no
 * long-lived local session to `--resume` across separate AgentRun Jobs — see
 * marker.ts — so continuity comes entirely from this re-framing plus
 * re-cloning the repo).
 */
export function buildPrompt(instruction: string, marker: SweMarker | null): string {
  const context = marker
    ? `You are CONTINUING work on an existing pull request.\n` +
      `- Repository: ${marker.repo}\n` +
      `- Branch: ${marker.branch}\n` +
      (marker.pr ? `- Pull request: #${marker.pr}\n` : ``) +
      `Clone the repository into the current directory (if not already present), check out that branch, and continue.`
    : `If the task needs an existing repository, clone it into the current directory. ` +
      `If it needs a NEW repository, create it with \`gh repo create\` (a private repo unless told otherwise) and clone it.`;

  return [
    `You are an autonomous software-engineering agent running headless in a container.`,
    `Complete the task below end-to-end and open (or update) a GitHub pull request with the result.`,
    ``,
    `## Task`,
    instruction.trim(),
    ``,
    `## Repository context`,
    context,
    ``,
    `## Environment`,
    `This container already has the following installed -- use them directly, do not apt-get/install/download them yourself:`,
    `git, gh (GitHub CLI, authenticated), curl, python3 + pip, node + npm, go, make, build-essential (gcc/g++), jq, unzip, zip, ripgrep (rg), less.`,
    `If a task genuinely needs something outside this list, install it yourself, but check this list first.`,
    ``,
    `## Rules (must follow)`,
    `- Work only inside the current working directory.`,
    `- Never commit directly to the default branch; use a dedicated feature branch.`,
    `- Commit with clear messages and push the branch to the remote.`,
    `- Open a pull request with \`gh pr create\` describing the change, or push to the existing PR branch if one is already open. Do NOT merge it.`,
    `- NEVER force-push, delete branches/repositories, run \`git reset --hard\`, or run other destructive/irreversible commands.`,
    `- You get exactly ONE turn to complete this task, and this process exits as soon as you reply -- there is no scheduler, cron, or webhook that will wake it back up later. You cannot pause partway through and wait for something external (a CI run, a build, a test job) to finish. Finish the task now with whatever information is available; if something is still pending, say so as a caveat in your final reply instead of deferring completion on it. Do NOT say you'll "resume automatically", "finalize later", or "when the check completes" -- that will never happen, and it leaves the task looking incomplete with no way for anyone to know a human needs to re-trigger you.`,
    `- When finished, print a short summary of what you changed and the pull request URL.`,
  ].join("\n");
}
