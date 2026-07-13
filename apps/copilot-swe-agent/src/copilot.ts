import type { SweMarker } from "./marker.js";

/**
 * Guardrails baked into every invocation. Copilot deny rules ALWAYS take
 * precedence over allow rules, even under `--allow-all-tools`
 * (see the Copilot CLI tool-permission docs), so this is the reliable lever
 * for "no irreversible actions". It is intentionally NOT configurable by the
 * caller. Defense-in-depth: the GitHub App's permissions and server-side
 * branch/repo protection rules are the other layers (see docs/security.md).
 */
export const DENY_TOOLS: string[] = [
  "shell(git push --force)",
  "shell(git push -f)",
  "shell(git push --force-with-lease)",
  "shell(git push --force-if-includes)",
  "shell(git reset --hard)",
  "shell(git branch -D)",
  "shell(git update-ref -d)",
  "shell(rm -rf)",
  "shell(gh repo delete)",
  "shell(gh api -X DELETE)",
  "shell(gh api --method DELETE)",
];

export interface CopilotArgsOptions {
  prompt: string;
  workdir: string;
  /** Copilot model id; empty => let Copilot choose. */
  model?: string;
}

/**
 * Builds the argv for a headless, autonomous, non-interactive Copilot run.
 *  - `-p`                      programmatic (run and exit)
 *  - `--allow-all-tools`       required for programmatic use
 *  - `--no-ask-user`           never block waiting for a human
 *  - `--disable-builtin-mcps`  we drive GitHub via `gh`/`git` with the App
 *                              installation token, not Copilot's built-in
 *                              GitHub MCP server (which would use the wrong
 *                              credential); keeps LLM auth and git auth cleanly
 *                              separate
 *  - `--deny-tool`             the non-negotiable guardrails above
 *  - `--output-format json`    JSONL we can turn into progress events
 */
export function buildCopilotArgs(opts: CopilotArgsOptions): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--allow-all-tools",
    "--allow-all-paths",
    "--no-ask-user",
    "--no-auto-update",
    "--no-color",
    "--disable-builtin-mcps",
    "--log-level",
    "error",
    "--output-format",
    "json",
    "--deny-tool",
    DENY_TOOLS.join(","),
    "-C",
    opts.workdir,
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  return args;
}

/**
 * The task prompt handed to Copilot. The user's instruction is embedded as
 * data; the surrounding text is fixed, trusted policy (the git workflow and
 * the "never destructive" rules). On a continuation turn the marker pins the
 * repo/branch/PR so Copilot resumes the same work.
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
 * A parsed signal from one line of Copilot's `--output-format json` (JSONL)
 * stream. Copilot CLI 1.0.70 emits typed events (`assistant.message`,
 * `assistant.reasoning_delta`, `tool.execution_start/complete`, ...); we pull
 * out narratable progress, the final assistant message, and any tool failure.
 */
export interface CopilotSignal {
  /** Human-readable text to narrate as progress. */
  progress?: string;
  /**
   * True when `progress` is a streaming token delta (e.g. `assistant.reasoning_delta`
   * / `assistant.message_delta`). Callers should accumulate these into a buffer
   * and flush as a single chunk rather than forwarding each token individually.
   */
  isDelta?: boolean;
  /** Content of an assistant message (the final summary is the last of these). */
  finalMessage?: string;
  /** Output of a tool execution that failed (non-zero exit / success:false). */
  toolFailure?: string;
}

/** Parses one JSONL line from Copilot into a {@link CopilotSignal}. Never throws; unknown shapes yield null. */
export function parseCopilotLine(line: string): CopilotSignal | null {
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
  const data = (typeof rec["data"] === "object" && rec["data"] !== null ? rec["data"] : {}) as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  switch (type) {
    case "assistant.message": {
      const content = str(data["content"]);
      // The tool-request message has empty content; only real text is a summary.
      return content ? { finalMessage: content, progress: content.slice(0, 200) } : null;
    }
    case "assistant.reasoning":
      return str(data["content"]) ? { progress: str(data["content"])! } : null;
    case "assistant.reasoning_delta":
    case "assistant.message_delta":
      return str(data["deltaContent"]) ? { progress: str(data["deltaContent"])!, isDelta: true } : null;
    case "tool.execution_start": {
      const name = str(data["toolName"]) ?? str(data["name"]);
      const desc = str(data["description"]) ?? str(data["intentionSummary"]);
      return name ? { progress: `running ${name}${desc ? `: ${desc}` : ""}` } : null;
    }
    case "tool.execution_complete": {
      const result = (typeof data["result"] === "object" && data["result"] !== null ? data["result"] : {}) as Record<string, unknown>;
      const content = str(result["content"]) ?? "";
      const failed = data["success"] === false || /exit code [1-9]/.test(content) || /Resource not accessible/i.test(content);
      return failed && content ? { toolFailure: content } : null;
    }
    default: {
      // Fallback for older/other shapes.
      for (const key of ["text", "content", "message", "delta"]) {
        const v = str(rec[key]);
        if (v) return { progress: v };
      }
      return null;
    }
  }
}
