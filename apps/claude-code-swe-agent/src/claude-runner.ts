import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /**
   * `"remote-control-url"` is emitted at most once by {@link runClaudeTurnRemoteControlled}
   * as soon as the Remote Control session URL is known, so a caller can surface a live
   * link to the user; `runClaudeTurn` never emits it.
   */
  onProgress?: (message: string, stage: "agent-text" | "agent" | "remote-control-url") => void;
  /** Override the "still working" heartbeat cadence (ms). Defaults to {@link HEARTBEAT_INTERVAL_MS}; injectable for tests. */
  heartbeatIntervalMs?: number;
}

export interface RemoteControlRunOptions extends ClaudeRunOptions {
  /**
   * Unique-per-run id used to derive a deterministic Remote Control session
   * name (e.g. the AgentRun id / `session.runId`), so the later `claude agents
   * --json` poll can find this exact session rather than guessing by prompt
   * text or recency.
   */
  runId: string;
  /** Cadence for polling `claude agents --json`. Defaults to {@link REMOTE_CONTROL_POLL_INTERVAL_MS}; injectable for tests. */
  pollIntervalMs?: number;
  /** Max time to wait for the background session to conclude before reporting a timeout failure. Defaults to {@link REMOTE_CONTROL_MAX_WAIT_MS}; injectable for tests. */
  maxWaitMs?: number;
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
function logProgress(stage: "agent-text" | "agent" | "remote-control-url", message: string): void {
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

// ---------------------------------------------------------------------------
// Remote Control path (interactive `claude --remote-control`, PTY-driven).
//
// Every fact below is CONFIRMED against a real logged-in CLI (v2.1.218) in a
// container matching the deployed image (see the commit message for the full
// investigation), NOT guessed:
//
//  - `--bg` does NOT establish a Remote Control bridge and never yields a
//    claude.ai URL. Only an INTERACTIVE `claude --remote-control` session
//    registers with claude.ai and produces a shareable link. So this runs
//    the CLI interactively, not backgrounded.
//  - Interactive claude needs a TTY, so it's launched under `script -q -c ...
//    /dev/null` (util-linux, already in the image) -- a real pty with no
//    native dependency. The prompt/settings/name travel via env vars so the
//    large, newline/quote-heavy prompt never has to be shell-escaped.
//  - The session id, remote URL, final reply, and completion marker all live
//    in the session's own JSONL transcript at
//    `~/.claude/projects/<cwd with / and . replaced by ->/<sessionId>.jsonl`:
//      * `bridgeSessionId` ("cse_XXXX")  -> URL https://claude.ai/code/session_XXXX
//      * last {type:"assistant"} text     -> the final reply
//      * a {type:"system",subtype:"turn_duration"} entry -> the turn finished
//    (`claude agents --json --all` is used only to discover our session's id;
//    it carries no URL/result field.)
//  - A fresh HOME must have onboarding + workspace-trust pre-seeded or the TUI
//    blocks on the theme picker / "trust this folder?" prompt before ever
//    registering (see `seedRemoteControlConfig`).
// ---------------------------------------------------------------------------

/** Cadence for polling `claude agents --json` (to find our session id) + re-reading the transcript. */
const REMOTE_CONTROL_POLL_INTERVAL_MS = 3_000;

/** Upper bound on how long to wait for the interactive session's turn to finish before giving up. */
const REMOTE_CONTROL_MAX_WAIT_MS = 30 * 60_000;

/**
 * Builds the Remote Control URL from a transcript `bridgeSessionId`, mirroring
 * the CLI's own `toCompatSessionId` (decompiled v2.1.218): a `cse_`-prefixed
 * id becomes `session_<rest>`, anything else passes through. Confirmed live:
 * transcript `bridgeSessionId: "cse_01YBWpf…"` yields exactly the
 * `https://claude.ai/code/session_01YBWpf…` the CLI itself prints.
 */
function remoteControlUrlFromBridge(bridgeSessionId: string): string {
  const compat = bridgeSessionId.startsWith("cse_") ? `session_${bridgeSessionId.slice(4)}` : bridgeSessionId;
  return `https://claude.ai/code/${compat}`;
}

/**
 * Pre-seeds the run's HOME so an interactive `claude` goes straight to
 * remote-control registration instead of stalling on a first-run prompt:
 *   - settings.json: `skipDangerousModePermissionPrompt` (the `--bg`/
 *     bypassPermissions disclaimer gate reads the ON-DISK file, not
 *     `--settings`), plus a theme so the theme picker never shows.
 *   - .claude.json: `hasCompletedOnboarding`, and per-cwd workspace trust so
 *     the "Is this a project you trust?" prompt never shows for `cwd`.
 * All confirmed necessary live -- without the trust entry for the exact cwd,
 * the session sits at the trust prompt and never registers. Merges rather
 * than clobbers (the login credentials/state also live in .claude.json).
 */
function seedRemoteControlConfig(homeDir: string, cwd: string): void {
  const claudeDir = join(homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // no existing settings.json, or not valid JSON -- start fresh
  }
  settings.skipDangerousModePermissionPrompt = true;
  if (!settings.theme) settings.theme = "dark";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const cfgPath = join(homeDir, ".claude.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    // no existing .claude.json yet
  }
  cfg.hasCompletedOnboarding = true;
  const projects =
    typeof cfg.projects === "object" && cfg.projects !== null ? (cfg.projects as Record<string, unknown>) : {};
  const existing = typeof projects[cwd] === "object" && projects[cwd] !== null ? (projects[cwd] as object) : {};
  projects[cwd] = { ...existing, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 5 };
  cfg.projects = projects;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

interface CapturedChild {
  code: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

/**
 * Spawns `claude` with the given args and buffers all of its stdout/stderr
 * until exit, rather than streaming NDJSON -- used for both the one-shot
 * `--bg --remote-control` handoff spawn and each `claude agents --json` poll,
 * neither of which is a long-lived `stream-json` process like `runClaudeTurn`'s
 * child. `mirrorStderr` mirrors to this process's own stderr the same way
 * `runClaudeTurn` does; disabled for polling spawns so a repeated poll every
 * few seconds doesn't spam `kubectl logs`.
 */
function spawnAndCapture(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; mirrorStderr: boolean },
): Promise<CapturedChild> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.mirrorStderr) process.stderr.write(clip(text, 2000));
    });
    child.on("error", (err) => resolve({ code: null, stdout, stderr, error: err }));
    child.on("close", (code) => resolve({ code, stdout, stderr, error: null }));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface InteractiveSession {
  /** The long UUID-shaped session id -- names the transcript file `<sessionId>.jsonl`. */
  sessionId: string;
  /** The short id (e.g. "9594acac"), used only for a best-effort `claude stop` on cleanup. */
  shortId: string | null;
  /** True when `agents --json` reports this session in a terminal-failed lifecycle state. */
  failed: boolean;
}

/**
 * Finds OUR interactive Remote Control session in a `claude agents --json
 * --all` payload -- the one whose `cwd` is (or is under) this run's working
 * directory and whose `kind` is `"interactive"`. Confirmed live: the session
 * the CLI registers for `--remote-control` shows up as `kind: "interactive"`;
 * its `name` is an auto-generated label (NOT the `--remote-control <name>` we
 * pass), so matching is by kind + cwd, not name. Returns `null` (never
 * throws) until the session appears / on any unexpected shape.
 */
function findInteractiveSession(raw: string, cwd: string): InteractiveSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).sessions)
      ? ((parsed as Record<string, unknown>).sessions as unknown[])
      : null;
  if (!list) return null;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (rec.kind !== "interactive") continue;
    const entryCwd = typeof rec.cwd === "string" ? rec.cwd : "";
    if (entryCwd !== cwd && !entryCwd.startsWith(`${cwd}/`) && !entryCwd.startsWith(cwd)) continue;
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
    if (!sessionId) continue;
    const state = String(rec.state ?? "").toLowerCase();
    const status = String(rec.status ?? "").toLowerCase();
    const TERMINAL_FAILED = ["failed", "error", "errored"];
    const failed = TERMINAL_FAILED.includes(state) || TERMINAL_FAILED.includes(status);
    return { sessionId, shortId: typeof rec.id === "string" ? rec.id : null, failed };
  }
  return null;
}

interface TranscriptState {
  /** The `bridgeSessionId` (e.g. "cse_01YB…") -> feeds `remoteControlUrlFromBridge`. Null until it appears. */
  bridgeSessionId: string | null;
  /** The last assistant text block -- the final reply, since `agents --json` carries no result field. */
  finalText: string | null;
  /** True once a `{type:"system",subtype:"turn_duration"}` entry appears, i.e. the turn finished. */
  turnComplete: boolean;
}

/**
 * Parses the session's JSONL transcript for everything the poll loop needs:
 * the `bridgeSessionId` (early summary line), the last assistant text (the
 * final reply), and whether a `turn_duration` system entry has appeared
 * (turn finished). All three confirmed present in a real interactive
 * Remote Control transcript. Defensive: skips unparseable lines, never
 * throws.
 */
function parseTranscript(raw: string): TranscriptState {
  let bridgeSessionId: string | null = null;
  let finalText: string | null = null;
  let turnComplete = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.bridgeSessionId === "string" && rec.bridgeSessionId) bridgeSessionId = rec.bridgeSessionId;
    if (rec.type === "system" && rec.subtype === "turn_duration") turnComplete = true;
    if (rec.type === "assistant" && typeof rec.message === "object" && rec.message !== null) {
      const content = (rec.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (b): b is { type: string; text: string } =>
              typeof b === "object" &&
              b !== null &&
              (b as { type?: unknown }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => b.text)
          .join("");
        if (text) finalText = text;
      }
    }
  }
  return { bridgeSessionId, finalText, turnComplete };
}

/** Reads the session's transcript, or null if it doesn't exist yet / can't be read. */
async function readTranscript(homeDir: string, cwd: string, sessionId: string): Promise<string | null> {
  try {
    return await readFile(join(homeDir, ".claude", "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`), "utf8");
  } catch {
    return null;
  }
}

/**
 * Turns an absolute cwd into Claude Code's own project-directory naming
 * convention under `~/.claude/projects/` -- confirmed empirically (a real
 * session's transcript directory): every `/` AND every `.` in the absolute
 * path is replaced with `-` (e.g. `/tmp/swe-x/agent-controller/.claude/y`
 * becomes `-tmp-swe-x-agent-controller--claude-y` -- note the double dash
 * where a path segment starting with `.` follows a `/`, since both
 * characters are replaced independently).
 */
function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Runs one turn via an INTERACTIVE `claude --remote-control` session, driven
 * under a pty via `script`. Used instead of `runClaudeTurn`'s one-shot `-p`
 * when Remote Control is enabled for the Agent (config.ts `remoteControlEnabled`;
 * `~/.claude/.credentials.json` seeded by the Go/Helm init-container first).
 * See the "Remote Control path" comment block above for why interactive (not
 * `--bg`) is the only mode that actually registers a claude.ai session + URL.
 *
 *   1. Seed onboarding/trust/disclaimer config for this run's HOME.
 *   2. Launch `claude --remote-control <name> --permission-mode bypassPermissions
 *      --settings <json> -- <prompt>` under `script -q -c … /dev/null` (a pty),
 *      passing name/settings/prompt via env vars (no shell-escaping the prompt).
 *   3. Poll `claude agents --json --all` to discover our interactive session's
 *      id, then read its JSONL transcript for the URL (`bridgeSessionId`), the
 *      final reply (last assistant text), and completion (`turn_duration`).
 *   4. Emit the URL via `onProgress` as soon as it's known (near the start),
 *      and resolve with the same `ClaudeRunResult` shape as `runClaudeTurn`
 *      once the turn completes / fails / the child exits / `maxWaitMs` elapses.
 *      The interactive session stays resident after its turn, so it's killed
 *      on the way out.
 */
export async function runClaudeTurnRemoteControlled(
  prompt: string,
  opts: RemoteControlRunOptions,
): Promise<ClaudeRunResult> {
  const homeDir = opts.env.HOME ?? "";
  seedRemoteControlConfig(homeDir, opts.cwd);

  const sessionName = `swe-${opts.runId}`;
  // Prompt/settings/name travel via env vars referenced (quoted) inside a
  // fixed wrapper string, so the large newline/quote/backtick-heavy prompt is
  // never shell-escaped by us. `exec` makes `script`'s child BE claude (clean
  // process-group kill). `script` supplies the pty interactive claude needs.
  const wrapper =
    'exec claude --remote-control "$RC_NAME" --permission-mode bypassPermissions --settings "$RC_SETTINGS"' +
    (opts.model ? ' --model "$RC_MODEL"' : "") +
    ' -- "$RC_PROMPT"';

  const child = spawn("script", ["-q", "-c", wrapper, "/dev/null"], {
    cwd: opts.cwd,
    env: {
      ...opts.env,
      RC_NAME: sessionName,
      RC_SETTINGS: JSON.stringify(opts.settings),
      RC_PROMPT: prompt,
      ...(opts.model ? { RC_MODEL: opts.model } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Buffer the pty output ONLY for auth-error classification on a startup
  // failure -- not mirrored to stderr (it's redraw-heavy TUI noise that would
  // swamp `kubectl logs`; progress is surfaced via heartbeats + the URL event).
  let ptyOutput = "";
  let childExited = false;
  let childExitCode: number | null = null;
  child.stdout?.on("data", (c: Buffer) => {
    ptyOutput += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    ptyOutput += c.toString();
  });
  child.on("close", (code) => {
    childExited = true;
    childExitCode = code;
  });
  child.on("error", () => {
    childExited = true;
  });

  const kill = (): void => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };

  let urlReported = false;
  const reportUrl = (url: string): void => {
    if (urlReported) return;
    urlReported = true;
    logProgress("remote-control-url", url);
    opts.onProgress?.(url, "remote-control-url");
  };

  const pollIntervalMs = opts.pollIntervalMs ?? REMOTE_CONTROL_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? REMOTE_CONTROL_MAX_WAIT_MS;
  const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const deadline = Date.now() + maxWaitMs;
  let lastHeartbeatAt = Date.now();

  try {
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        return { finalMessage: null, failed: true, failureDetail: "Aborted while waiting for the remote-control session", authError: false, sessionId: null };
      }

      const poll = await spawnAndCapture(["agents", "--json", "--all"], {
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        mirrorStderr: false,
      });
      const session = poll.error ? null : findInteractiveSession(poll.stdout, opts.cwd);

      if (session) {
        const raw = await readTranscript(homeDir, opts.cwd, session.sessionId);
        if (raw) {
          const st = parseTranscript(raw);
          // Emit the URL the moment it's known (well before completion) so the
          // caller posts the "watch it here" comment near the start of the run.
          if (st.bridgeSessionId) reportUrl(remoteControlUrlFromBridge(st.bridgeSessionId));
          if (st.turnComplete) {
            return { finalMessage: st.finalText, failed: false, failureDetail: null, authError: false, sessionId: session.sessionId };
          }
        }
        if (session.failed) {
          return {
            finalMessage: null,
            failed: true,
            failureDetail: clip(ptyOutput.trim(), 800) || "The remote-control session reported a failure",
            authError: looksLikeAuthError(ptyOutput),
            sessionId: session.sessionId,
          };
        }
      }

      // The interactive session stays resident after finishing its turn, so a
      // child exit BEFORE we saw `turn_duration` means it ended without
      // completing -- a startup failure (auth, an unexpected prompt, a crash).
      if (childExited) {
        return {
          finalMessage: null,
          failed: true,
          failureDetail: clip(ptyOutput.trim() || `claude exited with code ${childExitCode ?? "null"}`, 800),
          authError: looksLikeAuthError(ptyOutput),
          sessionId: session?.sessionId ?? null,
        };
      }

      if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
        lastHeartbeatAt = Date.now();
        const heartbeatMessage = "still running the remote-control session…";
        logProgress("agent", heartbeatMessage);
        opts.onProgress?.(heartbeatMessage, "agent");
      }

      await sleep(pollIntervalMs, opts.signal);
    }

    return {
      finalMessage: null,
      failed: true,
      failureDetail: `Timed out after ${maxWaitMs}ms waiting for the remote-control session to finish`,
      authError: false,
      sessionId: null,
    };
  } finally {
    kill();
  }
}
