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
  /** Override the "still working" heartbeat cadence (ms). Defaults to {@link HEARTBEAT_INTERVAL_MS}; injectable for tests. */
  heartbeatIntervalMs?: number;
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
 * Mirrors every progress event to this process's own stderr (visible via
 * `kubectl logs`), in addition to whatever `onProgress` forwards over NATS.
 * The stream-json events consumed from the child's stdout are otherwise
 * never echoed anywhere a human running `kubectl logs` would see them --
 * only the child's own stderr gets forwarded (see the `child.stderr` handler
 * below) -- so without this, the Job pod's logs show none of the agent's
 * actual tool-call trail.
 */
function logProgress(stage: "agent-text" | "agent", message: string): void {
  process.stderr.write(`[claude-runner] [${stage}] ${message}\n`);
}

/**
 * How often to emit a "still working" heartbeat while the CLI is silent.
 * Claude Code narrates a `tool_use` event when a tool STARTS but nothing
 * until it finishes, so a single long-running command (e.g. a full test
 * suite -- observed taking many minutes in a Job container) produces one
 * "running Bash" line and then total silence, which reads as a frozen
 * agent. A periodic heartbeat proves the run is alive; a real completion or
 * new event resets the idle clock so heartbeats only fire during genuine
 * silence.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

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

    // Heartbeat state: the tool most recently started, when the CLI last
    // emitted anything, and when the current in-flight tool began -- so a
    // heartbeat can say what's running and for how long.
    let lastTool: string | null = null;
    let lastActivityAt = Date.now();
    let currentToolStartedAt = Date.now();
    const markActivity = (): void => {
      lastActivityAt = Date.now();
    };

    const handleEvent = (event: unknown): void => {
      markActivity();
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
            logProgress("agent-text", b.text);
            opts.onProgress?.(b.text, "agent-text");
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            lastTool = b.name;
            currentToolStartedAt = Date.now();
            logProgress("agent", `running ${b.name}`);
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
      markActivity();
      process.stderr.write(clip(text, 2000));
    });

    // Fire a heartbeat only after a full interval of genuine silence (no
    // stream events, no stderr), so a long-running tool visibly stays alive
    // instead of looking hung. `unref()` so a stray interval can never keep
    // the process up past the child's own exit.
    const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivityAt < heartbeatMs) return;
      const secs = Math.round((Date.now() - currentToolStartedAt) / 1000);
      const heartbeatMessage = lastTool ? `still running ${lastTool}… (${secs}s)` : `still working… (${secs}s)`;
      logProgress("agent", heartbeatMessage);
      opts.onProgress?.(heartbeatMessage, "agent");
    }, heartbeatMs);
    heartbeat.unref?.();

    child.on("error", (err) => {
      clearInterval(heartbeat);
      resolve({
        finalMessage,
        failed: true,
        failureDetail: err.message,
        authError: looksLikeAuthError(err.message),
        sessionId,
      });
    });

    child.on("close", (code) => {
      clearInterval(heartbeat);
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
