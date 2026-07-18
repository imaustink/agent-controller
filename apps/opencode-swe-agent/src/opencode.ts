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
 * Builds the opencode.json config (schema: https://opencode.ai/config.json)
 * written to `$XDG_CONFIG_HOME/opencode/opencode.json` before each run. Pins
 * the model and bakes in the non-negotiable bash deny rules; `"*": "allow"`
 * plus `--auto` on the CLI keeps everything else non-interactive.
 */
export function buildOpencodeConfig(opts: OpencodeConfigOptions): object {
  const bash: Record<string, string> = { "*": "allow" };
  for (const pattern of DENY_BASH_PATTERNS) bash[pattern] = "deny";
  return {
    $schema: "https://opencode.ai/config.json",
    model: opts.model,
    permission: { bash },
  };
}

export interface OpencodeArgsOptions {
  prompt: string;
  workdir: string;
  /** opencode model id in `provider/model` form; empty => opencode's configured default. */
  model?: string;
}

/**
 * Builds the argv for a headless, autonomous, non-interactive opencode run.
 *  - `run <prompt>`   the headless single-shot subcommand (opencode.ai/docs/cli)
 *  - `--auto`         auto-approve anything not resolved by an explicit
 *                      permission rule (opencode's analogue of `--allow-all-tools`);
 *                      explicit `deny` rules in opencode.json still win
 *  - `--dir`          working directory for the run
 *  - `--format json`  machine-readable event stream we turn into progress events
 *  - `--model`        overrides the opencode.json default when set
 */
export function buildOpencodeArgs(opts: OpencodeArgsOptions): string[] {
  const args = ["run", opts.prompt, "--auto", "--dir", opts.workdir, "--format", "json"];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  return args;
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

/**
 * A parsed signal from one line of opencode's `--format json` event stream.
 *
 * NOTE: opencode's exact JSON event schema for headless `run --format json`
 * is not fully documented publicly at the time this was written (opencode is
 * built on the Vercel AI SDK, whose stream parts commonly look like
 * `{"type":"text-delta","text":"..."}` / `{"type":"tool-call",...}` /
 * `{"type":"tool-result",...}`, and opencode's own server/TUI model exposes
 * "message part" updates like `{"type":"message.part.updated", ...}`). This
 * parser is deliberately defensive: it tries several plausible shapes and
 * falls back to generic text-bearing keys, the same way the previous Copilot
 * parser had a fallback branch for unknown shapes. Verify against real
 * `opencode run --format json` output and tighten this once confirmed.
 */
export interface OpencodeSignal {
  /** Human-readable text to narrate as progress. */
  progress?: string;
  /**
   * True when `progress` is a streaming token delta. Callers should
   * accumulate these into a buffer and flush as a single chunk rather than
   * forwarding each token individually.
   */
  isDelta?: boolean;
  /**
   * "narrative" is the agent's own words (assistant text/reasoning) — worth
   * showing to the user as real conversation content. "status" is mechanical
   * bookkeeping (tool invocations, fallback shapes) — worth a terse spinner
   * line, not a paragraph in the chat. Defaults to "status" when omitted.
   */
  progressKind?: "narrative" | "status";
  /** Content of an assistant message (the final summary is the last of these). */
  finalMessage?: string;
  /** Output of a tool execution that failed (non-zero exit / success:false). */
  toolFailure?: string;
}

/** Parses one JSONL line from opencode into an {@link OpencodeSignal}. Never throws; unknown shapes yield null. */
export function parseOpencodeLine(line: string): OpencodeSignal | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const type = typeof rec["type"] === "string" ? (rec["type"] as string) : "";
  const part = (typeof rec["part"] === "object" && rec["part"] !== null ? rec["part"] : rec) as Record<
    string,
    unknown
  >;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  switch (type) {
    case "text":
    case "text-delta":
    case "assistant.message":
    case "message.part.updated": {
      const content = str(part["text"]) ?? str(part["content"]) ?? str(rec["text"]) ?? str(rec["content"]);
      if (!content) return null;
      const isDelta = type === "text-delta";
      return isDelta
        ? { progress: content, isDelta: true, progressKind: "narrative" }
        : { finalMessage: content, progress: content, progressKind: "narrative" };
    }
    case "reasoning":
    case "reasoning-delta":
      return str(part["text"])
        ? { progress: str(part["text"])!, isDelta: type === "reasoning-delta", progressKind: "narrative" }
        : null;
    case "tool-call":
    case "tool_use": {
      const name = str(rec["toolName"]) ?? str(part["tool"]) ?? str(rec["tool"]);
      return name ? { progress: `running ${name}`, progressKind: "status" } : null;
    }
    case "tool-result":
    case "tool_result": {
      const isError = rec["isError"] === true || rec["success"] === false;
      const content = str(rec["result"]) ?? str(rec["output"]) ?? str(rec["error"]);
      return isError && content ? { toolFailure: content } : null;
    }
    case "error":
      return str(rec["message"]) ? { toolFailure: str(rec["message"])! } : null;
    default: {
      // Fallback for unconfirmed/other shapes.
      for (const key of ["text", "content", "message", "delta"]) {
        const v = str(rec[key]) ?? str(part[key]);
        if (v) return { progress: v };
      }
      return null;
    }
  }
}
