import { spawn } from "node:child_process";
import { clip } from "./security/redact.js";

export interface ClaudeRunResult {
  finalMessage: string | null;
  failed: boolean;
  failureDetail: string | null;
  /** True when the failure looks like an auth/credential problem (expired/invalid token) rather than an ordinary task failure -- see {@link looksLikeAuthError}. */
  authError: boolean;
  /** Claude Code's own session id for this turn, if the CLI reported one (informational only -- see marker.ts, this is never passed to `--resume` across separate AgentRun Jobs). */
  sessionId: string | null;
}

export interface ClaudeRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  settings: object;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (message: string, stage: "agent-text" | "agent") => void;
}

/**
 * Substrings that indicate the failure is a credential problem the caller
 * should surface distinctly (so the orchestrator can trigger re-auth)
 * instead of an ordinary task failure. Best-effort text matching -- Claude
 * Code's `stream-json` `result` event does carry a `subtype` field for some
 * failure classes, but not a stable machine-readable "auth expired" code, so
 * this also checks stderr/the result text. Confirm and extend this list
 * empirically against the pinned CLI version (see claude-runner.test.ts) --
 * unlike opencode-server.ts there's no `/doc` OpenAPI spec to check these
 * shapes against.
 */
const AUTH_ERROR_SUBSTRINGS = [
  "invalid api key",
  "invalid x-api-key",
  "authentication_error",
  "oauth token has expired",
  "oauth token is invalid",
  "please run `claude setup-token`",
  "please run /login",
  "credit balance is too low",
];

function looksLikeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Runs one `claude -p` turn to completion, parsing its
 * `--output-format stream-json` NDJSON stream (one JSON object per line).
 * Mirrors opencode-server.ts's `sendMessage`/`narrateOpencodeEvent` role, but
 * as a one-shot CLI invocation rather than a call against a long-lived
 * server -- this agent has no `opencode serve` analogue to talk to (see
 * marker.ts/claude.ts for why).
 */
export function runClaudeTurn(prompt: string, opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      JSON.stringify(opts.settings),
    ];
    if (opts.model) args.push("--model", opts.model);

    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let sessionId: string | null = null;
    let finalMessage: string | null = null;
    let resultIsError = false;
    let stderrBuf = "";
    let stdoutLineBuf = "";
    let sawAnyJson = false;

    const handleEvent = (event: unknown): void => {
      if (typeof event !== "object" || event === null) return;
      const rec = event as Record<string, unknown>;
      const type = typeof rec.type === "string" ? rec.type : "";

      if (type === "system" && rec.subtype === "init" && typeof rec.session_id === "string") {
        sessionId = rec.session_id;
        return;
      }

      if (type === "assistant" && typeof rec.message === "object" && rec.message !== null) {
        const message = rec.message as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            opts.onProgress?.(b.text, "agent-text");
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            opts.onProgress?.(`running ${b.name}`, "agent");
          }
        }
        return;
      }

      if (type === "result") {
        if (typeof rec.session_id === "string") sessionId = rec.session_id;
        resultIsError = rec.is_error === true;
        if (typeof rec.result === "string") finalMessage = rec.result;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLineBuf += chunk.toString();
      let idx: number;
      while ((idx = stdoutLineBuf.indexOf("\n")) >= 0) {
        const line = stdoutLineBuf.slice(0, idx).trim();
        stdoutLineBuf = stdoutLineBuf.slice(idx + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
          sawAnyJson = true;
        } catch {
          // Non-JSON line (shouldn't happen in stream-json mode) -- ignore.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      process.stderr.write(clip(text, 2000));
    });

    child.on("error", (err) => {
      resolve({
        finalMessage,
        failed: true,
        failureDetail: err.message,
        authError: looksLikeAuthError(err.message),
        sessionId,
      });
    });

    child.on("close", (code) => {
      const trailing = stdoutLineBuf.trim();
      if (trailing) {
        try {
          handleEvent(JSON.parse(trailing));
          sawAnyJson = true;
        } catch {
          // ignore trailing partial/non-JSON output
        }
      }

      const failed = code !== 0 || resultIsError || !sawAnyJson;
      const failureDetail = failed
        ? (finalMessage ?? (stderrBuf.trim() ? clip(stderrBuf, 800) : `claude exited with code ${code ?? "null"}`))
        : null;
      const authError = failed && looksLikeAuthError(`${stderrBuf}\n${finalMessage ?? ""}`);

      resolve({ finalMessage, failed, failureDetail, authError, sessionId });
    });
  });
}
