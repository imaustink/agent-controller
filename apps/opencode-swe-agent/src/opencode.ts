import type { SweMarker } from "./marker.js";

/**
 * Guardrails baked into every invocation, as `permission.bash` deny rules in
 * the generated opencode.json (see {@link buildOpencodeConfig}). opencode
 * resolves bash permission by last-match-wins glob, and an explicit `deny`
 * entry is enforced even when `--auto` would otherwise approve everything
 * (see the opencode permissions docs), so this is the reliable lever for
 * "no irreversible actions". It is intentionally NOT configurable by the
 * caller. Defense-in-depth: the GitHub App's permissions and server-side
 * branch/repo protection rules are the other layers (see docs/security.md).
 */
export const DENY_BASH_PATTERNS: string[] = [
  "git push --force*",
  "git push -f*",
  "git push --force-with-lease*",
  "git push --force-if-includes*",
  "git reset --hard*",
  "git branch -D*",
  "git update-ref -d*",
  "rm -rf*",
  "gh repo delete*",
  "gh api -X DELETE*",
  "gh api --method DELETE*",
];

export interface OpencodeConfigOptions {
  /** opencode model id in `provider/model` form, e.g. "anthropic/claude-sonnet-5". */
  model: string;
}

/**
 * Every other opencode permission category (confirmed against its own
 * `/doc` OpenAPI spec's `PermissionConfig` schema), set to a blanket
 * `"allow"` since `opencode serve` (ADR 0026) has no `--auto` CLI flag --
 * unlike the old one-shot `opencode run --auto`, non-interactivity for
 * these has to come entirely from config now. `bash` is deliberately NOT
 * listed here -- it keeps its own glob-keyed deny rules below, the one
 * category with a real "irreversible action" risk worth denying outright
 * rather than just defaulting to allow.
 */
const ALLOW_ALL_OTHER_CATEGORIES: Record<string, string> = {
  read: "allow",
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  task: "allow",
  external_directory: "allow",
  lsp: "allow",
  skill: "allow",
  todowrite: "allow",
  question: "allow",
  webfetch: "allow",
  websearch: "allow",
};

/**
 * Builds the opencode.json config (schema: https://opencode.ai/config.json)
 * written to `$XDG_CONFIG_HOME/opencode/opencode.json` before opencode serve
 * (ADR 0026) is spawned. Pins the model and bakes in the non-negotiable bash
 * deny rules; everything else defaults to "allow" (see
 * {@link ALLOW_ALL_OTHER_CATEGORIES}) so `opencode serve` never blocks
 * waiting on an interactive permission prompt nobody's there to answer.
 */
export function buildOpencodeConfig(opts: OpencodeConfigOptions): object {
  const bash: Record<string, string> = { "*": "allow" };
  for (const pattern of DENY_BASH_PATTERNS) bash[pattern] = "deny";
  return {
    $schema: "https://opencode.ai/config.json",
    model: opts.model,
    permission: { ...ALLOW_ALL_OTHER_CATEGORIES, bash },
  };
}

/**
 * The task prompt handed to opencode. The user's instruction is embedded as
 * data; the surrounding text is fixed, trusted policy (the git workflow and
 * the "never destructive" rules). On a continuation turn the marker pins the
 * repo/branch/PR so opencode resumes the same work.
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
    `- When finished, print a short summary of what you changed and the pull request URL.`,
  ].join("\n");
}

// Event parsing/completion-detection for opencode's headless CLI
// (`opencode run --format json`) used to live here. Superseded by ADR 0026:
// `opencode-swe-agent` now drives a long-lived `opencode serve` process
// instead (see `opencode-server.ts`) -- `sendMessage`'s HTTP response is
// already the completed assistant message (no stdout JSONL to parse), and
// the raw `/event` SSE stream is forwarded verbatim for a live viewer
// (index.ts), not parsed here.
