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
  /**
   * Fallback bound, used only while the session reports no `status`: how long
   * it may go with NO new transcript activity before the turn is given up on.
   * Bounds SILENCE, not total duration. Defaults to
   * {@link REMOTE_CONTROL_IDLE_TIMEOUT_MS}; injectable for tests.
   */
  idleTimeoutMs?: number;
  /** Bound on a session reporting `status: "idle"`. Defaults to {@link REMOTE_CONTROL_IDLE_STATUS_GRACE_MS}. */
  idleStatusGraceMs?: number;
  /** Bound on a session reporting `status: "waiting"`. Defaults to {@link REMOTE_CONTROL_WAITING_TIMEOUT_MS}. */
  waitingTimeoutMs?: number;
  /**
   * How long to wait for the interactive session to register with the CLI at
   * all before giving up on startup. Defaults to
   * {@link REMOTE_CONTROL_STARTUP_TIMEOUT_MS}; injectable for tests.
   */
  startupTimeoutMs?: number;
  /**
   * Optional ABSOLUTE wall-clock backstop. Defaults to no bound at all: a real
   * coding turn can legitimately run for hours, the idle bound above is what
   * ends a stuck one, and the AgentRun Job's `activeDeadlineSeconds` is the
   * ceiling (see agent-orchestrator's `config.ts`). Set only when a caller
   * genuinely wants to cap total duration.
   */
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
  // Confirmed empirically, not guessed: this is verbatim what the CLI reported
  // when a seeded ~/.claude/.credentials.json could no longer be refreshed
  // (AgentRun fc9f0896, an "ai-review" run that died 11s in). Redundant with
  // "please run /login" for that exact wording, but the two halves of that
  // message are not guaranteed to travel together.
  "login expired",
  "please run `claude setup-token`",
  "please run /login",
  "credit balance is too low",
];

function looksLikeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Longest turn output still treated as "this is an auth notice, not work".
 * A credential message is a single short line; a real turn summary (or a code
 * review that happens to DISCUSS auth) is far longer. Without this bound,
 * reviewing a file that contains the string "invalid api key" would be
 * misreported as an expired credential.
 */
const AUTH_NOTICE_MAX_LENGTH = 200;

/**
 * True when a turn the CLI reported as FINISHED actually just handed back a
 * credential complaint as its output.
 *
 * This is the failure mode that made AgentRun fc9f0896 (an "ai-review" run)
 * look successful: the interactive session recorded `Login expired · Please
 * run /login` as its assistant text and wrote a `turn_duration` entry 11
 * seconds in, so `turnComplete` was true, `failed` was false, and the auth
 * error travelled all the way to the user as a turn summary -- under
 * "The agent produced no pushable repository or pull request. Details: ...".
 * Nothing downstream could act on it because nothing upstream had called it a
 * failure. So the completion signal alone is not sufficient evidence of a
 * completed turn; the output has to not be an auth complaint.
 */
function isAuthFailureDisguisedAsSuccess(text: string | null): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed.length > AUTH_NOTICE_MAX_LENGTH) return false;
  return looksLikeAuthError(trimmed);
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

      // On an already-failed turn, scan everything (stderr included). On a
      // turn the CLI called successful, only a short auth-notice-shaped
      // `result` counts -- an auth error reported as the turn's own output is
      // still an auth error (see `isAuthFailureDisguisedAsSuccess`), but a long
      // summary that merely mentions credentials is not.
      const hardFailed = code !== 0 || resultIsError || !sawAnyJson;
      const authError = hardFailed
        ? looksLikeAuthError(`${stderrBuf}\n${finalMessage ?? ""}`)
        : isAuthFailureDisguisedAsSuccess(finalMessage);
      const failed = hardFailed || authError;
      const failureDetail = failed
        ? (finalMessage ?? (stderrBuf.trim() ? clip(stderrBuf, 800) : `claude exited with code ${code ?? "null"}`))
        : null;

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

/**
 * FALLBACK bound, used only while the session reports no `status` (see
 * {@link SessionStatus}): how long it may produce NO new transcript activity
 * before the turn is declared stuck. When a status IS reported it is strictly
 * better evidence and this does not apply -- `busy` means the session is
 * working and duration is not our business, however static its transcript.
 *
 * This replaces a 30-minute ABSOLUTE cap, which is the defect behind issue
 * #149: a run that was working correctly the whole time was killed at exactly
 * 1800000ms and reported to the user as "Timed out ... waiting for the
 * remote-control session to finish". Every other bound in this system
 * deliberately measures silence rather than duration -- see
 * agent-orchestrator's `agentIdleTimeoutSeconds` ("Bounds SILENCE, not total
 * duration ... a run that narrates is never cut off however long it takes")
 * and `agentRunTimeoutSeconds` ("a real coding task ... can legitimately take
 * hours"). The one-shot `runClaudeTurn` path has no wall-clock cap either; it
 * simply waits for the child. The remote-control path was the lone exception,
 * and 30 minutes is well inside the range an ordinary feature-sized coding
 * task occupies.
 *
 * Sized above the longest silence a HEALTHY session produces. The transcript
 * gains an entry for every assistant message, tool call, and tool result, so
 * the only real quiet stretch is a single long-running tool (a full test suite
 * -- observed taking many minutes in a Job container). 20 minutes is several
 * times that, and it also leaves room for a human who has taken over the
 * session via its claude.ai URL to think between messages.
 *
 * That reasoning is a guess with a rationale, which is exactly why it is now
 * only the fallback: it cannot tell a wedged session from a slow tool call,
 * because from outside the process those are identical. The status signal can.
 */
const REMOTE_CONTROL_IDLE_TIMEOUT_MS = 20 * 60_000;

/**
 * How long a session that reports `status: "idle"` may stay idle, with a
 * static transcript, before the turn is declared stuck.
 *
 * Far shorter than {@link REMOTE_CONTROL_IDLE_TIMEOUT_MS} because it is a far
 * better-informed judgement: the session is not saying "quiet", it is saying
 * "not working". The only reason to tolerate any idle at all is that a session
 * is briefly idle between registering and picking up its prompt, and could in
 * principle blip idle between steps. Any `busy` sample resets this, so a blip
 * costs nothing.
 */
const REMOTE_CONTROL_IDLE_STATUS_GRACE_MS = 90_000;

/**
 * How long a session that reports `status: "waiting"` may stay blocked before
 * the turn gives up.
 *
 * Nothing in a headless Job will ever answer the prompt it is blocked on, so
 * this could be zero. It is not, because the product explicitly advertises the
 * opposite: the run's first comment is "Watch live or take over the session
 * here", and a human who does take over needs a window to answer. Bounded
 * anyway -- an unattended run at 3am must not hold a pod until the Job
 * deadline waiting for someone who is asleep.
 */
const REMOTE_CONTROL_WAITING_TIMEOUT_MS = 5 * 60_000;

/**
 * How long to wait for the interactive session to appear in `claude agents
 * --json` at all. A separate, much shorter bound than the idle one: before a
 * session registers there is no transcript to measure silence against, and a
 * CLI wedged on an unexpected first-run prompt never exits (so the `childExited`
 * check below never fires) -- it just sits at the TUI forever. Registration
 * takes seconds when it works.
 */
const REMOTE_CONTROL_STARTUP_TIMEOUT_MS = 5 * 60_000;

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

/**
 * What `agents --json` reports a session to be doing. CONFIRMED against a real
 * CLI (v2.1.220), both live and by reading the bundle -- the listing builds
 * each entry with `...d.status && {status: EMm(d.status)}` and
 * `...d.status === "waiting" && d.waitingFor && {waitingFor: d.waitingFor}`,
 * where `EMm` is total:
 *
 *   EMm(e) = e === "idle" ? "idle" : e === "waiting" ? "waiting" : "busy"
 *
 * so the field is exactly these three values or absent (an unrecognized
 * internal status becomes `"busy"`, which is the safe direction for us).
 * The status itself is computed as:
 *
 *   waiting -> a prompt/dialog is up (see {@link InteractiveSession.waitingFor})
 *   busy    -> `isLoading || delegatedActive`, i.e. genuinely working
 *   idle    -> neither
 */
type SessionStatus = "idle" | "waiting" | "busy";

const SESSION_STATUSES: readonly string[] = ["idle", "waiting", "busy"];

interface InteractiveSession {
  /** The long UUID-shaped session id -- names the transcript file `<sessionId>.jsonl`. */
  sessionId: string;
  /** The short id (e.g. "9594acac"), used only for a best-effort `claude stop` on cleanup. */
  shortId: string | null;
  /** True when `agents --json` reports this session in a terminal-failed lifecycle state. */
  failed: boolean;
  /**
   * The session's own account of what it is doing, or `null` when the listing
   * omits it (it is emitted conditionally, so a session that has not reported
   * one yet simply has no field). `null` means "no opinion" and must never be
   * read as "not working" -- the caller falls back to the transcript.
   */
  status: SessionStatus | null;
  /**
   * Why the session is blocked, when `status === "waiting"`. Free text from the
   * CLI: `"input needed"`, `"dialog open"`, `"sandbox request"`, `"worker
   * request"`, or the specific dialog's own label.
   */
  waitingFor: string | null;
}

/**
 * Finds OUR interactive Remote Control session in a `claude agents --json
 * --all` payload -- the one whose `cwd` is (or is under) this run's working
 * directory and whose `kind` is `"interactive"`. Confirmed live: the session
 * the CLI registers for `--remote-control` shows up as `kind: "interactive"`;
 * its `name` is an auto-generated label (NOT the `--remote-control <name>` we
 * pass), so matching is by kind + cwd, not name.
 *
 * `exclude` holds the interactive session ids that already existed at this cwd
 * BEFORE this run spawned its own, and they are skipped. `--all` lists ended
 * sessions too, so on a second turn in the same pod the previous turn's
 * session is still listed at the same cwd and would otherwise be matched
 * first -- and its transcript already carries a `turn_duration`, which would
 * hand the previous turn's answer back as this turn's, instantly and
 * silently.
 *
 * Returns `null` (never throws) until a session appears / on any unexpected
 * shape.
 */
function findInteractiveSession(
  raw: string,
  cwd: string,
  exclude: ReadonlySet<string> = new Set(),
): InteractiveSession | null {
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
    if (!sessionId || exclude.has(sessionId)) continue;
    const state = String(rec.state ?? "").toLowerCase();
    const rawStatus = String(rec.status ?? "").toLowerCase();
    // Kept as a defensive path even though the v2.1.220 listing cannot produce
    // it (`EMm` maps every internal status into idle/waiting/busy, and no
    // `state` key is emitted for an interactive entry) -- the shape is not
    // contractual across CLI versions, and mistaking a failed session for a
    // running one is the more expensive error.
    const TERMINAL_FAILED = ["failed", "error", "errored"];
    const failed = TERMINAL_FAILED.includes(state) || TERMINAL_FAILED.includes(rawStatus);
    return {
      sessionId,
      shortId: typeof rec.id === "string" ? rec.id : null,
      failed,
      status: SESSION_STATUSES.includes(rawStatus) ? (rawStatus as SessionStatus) : null,
      waitingFor: typeof rec.waitingFor === "string" && rec.waitingFor ? rec.waitingFor : null,
    };
  }
  return null;
}

/**
 * Every interactive session id `agents --json --all` reports at `cwd`, used to
 * snapshot what already existed before this run spawned its own (see
 * {@link findInteractiveSession}'s `exclude`).
 */
function listInteractiveSessionIds(raw: string, cwd: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  // Reuse the one matcher so "which sessions count as at this cwd" cannot
  // drift between the snapshot and the later lookup.
  for (;;) {
    const found = findInteractiveSession(raw, cwd, seen);
    if (!found) return ids;
    ids.add(found.sessionId);
    seen.add(found.sessionId);
  }
}

/** A narratable thing the session did, derived from one transcript entry. */
interface TranscriptEvent {
  kind: "agent-text" | "agent";
  message: string;
}

interface TranscriptState {
  /** The `bridgeSessionId` (e.g. "cse_01YB…") -> feeds `remoteControlUrlFromBridge`. Null until it appears. */
  bridgeSessionId: string | null;
  /** The last assistant text block -- the final reply, since `agents --json` carries no result field. */
  finalText: string | null;
  /** True once a `{type:"system",subtype:"turn_duration"}` entry appears, i.e. the turn finished. */
  turnComplete: boolean;
  /**
   * Count of parsed transcript entries. This is the run's liveness signal: the
   * transcript gains an entry for every assistant message, tool call, and tool
   * result, so a growing count is proof the session is doing work and a static
   * one is the only honest definition of "stuck".
   *
   * Deliberately NOT measured from the pty output, which a TUI redraws
   * continuously whether or not anything is happening -- treating that as
   * activity would make the idle bound unable to ever fire.
   */
  entryCount: number;
  /** Narratable events in transcript order, so newly-appeared ones can be forwarded as progress. */
  events: TranscriptEvent[];
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
  let entryCount = 0;
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    entryCount += 1;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.bridgeSessionId === "string" && rec.bridgeSessionId) bridgeSessionId = rec.bridgeSessionId;
    if (rec.type === "system" && rec.subtype === "turn_duration") turnComplete = true;
    if (rec.type === "assistant" && typeof rec.message === "object" && rec.message !== null) {
      const content = (rec.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            texts.push(b.text);
            events.push({ kind: "agent-text", message: b.text });
          } else if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
            events.push({ kind: "agent", message: `running ${b.name}` });
          }
        }
        const text = texts.join("");
        if (text) finalText = text;
      }
    }
  }
  return { bridgeSessionId, finalText, turnComplete, entryCount, events };
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
 *      narrate each new transcript entry as it appears, and resolve with the
 *      same `ClaudeRunResult` shape as `runClaudeTurn` once the turn completes
 *      / fails / the child exits / the session goes silent for `idleTimeoutMs`.
 *      The interactive session stays resident after its turn, so it's killed
 *      on the way out.
 *
 * The wait is never bounded by total duration -- see issue #149, where a
 * healthy long-running turn was killed by a 30-minute absolute cap. What ends
 * it is the session's own reported {@link SessionStatus} (`busy` runs as long
 * as it likes; `idle` and `waiting` each have their own short bound), falling
 * back to transcript silence only while no status is reported.
 */
export async function runClaudeTurnRemoteControlled(
  prompt: string,
  opts: RemoteControlRunOptions,
): Promise<ClaudeRunResult> {
  const homeDir = opts.env.HOME ?? "";
  seedRemoteControlConfig(homeDir, opts.cwd);

  // Snapshot the interactive sessions that already exist at this cwd BEFORE
  // spawning ours, so the poll below cannot mistake a previous turn's session
  // (still listed by `--all`, transcript already carrying a `turn_duration`)
  // for this turn's. A failed probe just yields an empty set -- the same
  // behaviour as before this snapshot existed.
  const preExisting = await spawnAndCapture(["agents", "--json", "--all"], {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    mirrorStderr: false,
  });
  const priorSessionIds = preExisting.error ? new Set<string>() : listInteractiveSessionIds(preExisting.stdout, opts.cwd);

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

  /**
   * When we last told the caller ANYTHING. Distinct from the stall clock
   * below, and load-bearing: the orchestrator ends a turn after
   * `agentIdleTimeoutSeconds` without an up-message (10 min), so this
   * guarantees we speak often enough to stay inside that whatever the session
   * is doing. Collapsing the two clocks would silence us for exactly the case
   * that most needs narrating -- a long `busy` tool call, which resets the
   * stall clock on every poll while emitting no transcript entries at all.
   */
  let lastEmitAt = Date.now();
  const emit = (message: string, stage: "agent-text" | "agent" | "remote-control-url"): void => {
    lastEmitAt = Date.now();
    logProgress(stage, message);
    opts.onProgress?.(message, stage);
  };

  let urlReported = false;
  const reportUrl = (url: string): void => {
    if (urlReported) return;
    urlReported = true;
    emit(url, "remote-control-url");
  };

  const pollIntervalMs = opts.pollIntervalMs ?? REMOTE_CONTROL_POLL_INTERVAL_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? REMOTE_CONTROL_IDLE_TIMEOUT_MS;
  const idleStatusGraceMs = opts.idleStatusGraceMs ?? REMOTE_CONTROL_IDLE_STATUS_GRACE_MS;
  const waitingTimeoutMs = opts.waitingTimeoutMs ?? REMOTE_CONTROL_WAITING_TIMEOUT_MS;
  const startupTimeoutMs = opts.startupTimeoutMs ?? REMOTE_CONTROL_STARTUP_TIMEOUT_MS;
  const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  // No absolute cap by default -- see `maxWaitMs`'s doc comment and issue #149.
  const absoluteDeadline = opts.maxWaitMs === undefined ? Infinity : Date.now() + opts.maxWaitMs;
  const startedAt = Date.now();

  // Liveness state. `lastProgressAt` is the STALL clock: reset by growth in the
  // transcript and by a `busy` status -- never by the mere passage of polls,
  // and never by pty output (a TUI redraws continuously whether or not
  // anything is happening, so counting it would stop the bound ever firing).
  let lastProgressAt = Date.now();
  /** Last growth in the transcript specifically -- for wording, not for deciding. */
  let lastTranscriptAt = Date.now();
  let sessionFoundAt: number | null = null;
  /** Our session's id once discovered -- carried into a give-up result so a stuck run is traceable to a transcript. */
  let discoveredSessionId: string | null = null;
  let entryCount = 0;
  let narratedEvents = 0;
  let sawTurnActivity = false;
  let lastActivity: string | null = null;
  /** The session's last reported status, so a give-up message can say which signal ended the wait. */
  let lastStatus: SessionStatus | null = null;
  /** When the session first reported `waiting` without having moved since. */
  let waitingSinceAt: number | null = null;
  /** The reason accompanying the most recent `waiting` status, for the give-up message. */
  let lastWaitingFor: string | null = null;

  /**
   * Distinguishes the two shapes of "we gave up waiting", because the previous
   * single message ("Timed out after 1800000ms…") could not tell them apart and
   * that ambiguity is most of why issue #149 stayed open: a session that
   * registered but never began its turn (the prompt never landed) and a session
   * that worked and then wedged look identical from the outside.
   */
  const idleFailure = (silentForMs: number): ClaudeRunResult => {
    const silentSecs = Math.round(silentForMs / 1000);
    const ranForSecs = Math.round((Date.now() - startedAt) / 1000);
    // `idle` is the session's own word for it; no status at all means we are
    // inferring from silence and should say so rather than overclaim.
    const basis = lastStatus === "idle" ? `reported itself idle for ${silentSecs}s` : `produced no transcript activity for ${silentSecs}s (status not reported)`;
    const detail = sawTurnActivity
      ? `The remote-control session stopped working: ${basis} (turn ran ${ranForSecs}s, ${entryCount} transcript entries` +
        `${lastActivity ? `, last activity: ${clip(lastActivity, 200)}` : ""}).`
      : `The remote-control session registered but never started its turn: ${basis}. ` +
        `The prompt may not have been submitted to the session.`;
    return { finalMessage: null, failed: true, failureDetail: detail, authError: false, sessionId: discoveredSessionId };
  };

  try {
    for (;;) {
      if (opts.signal?.aborted) {
        return { finalMessage: null, failed: true, failureDetail: "Aborted while waiting for the remote-control session", authError: false, sessionId: null };
      }

      const poll = await spawnAndCapture(["agents", "--json", "--all"], {
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        mirrorStderr: false,
      });
      const session = poll.error ? null : findInteractiveSession(poll.stdout, opts.cwd, priorSessionIds);

      if (session) {
        discoveredSessionId = session.sessionId;
        lastStatus = session.status;
        // `busy` is the session itself saying it is working, which is stronger
        // evidence than anything the transcript can offer: a single long tool
        // call writes `tool_use` when it STARTS and `tool_result` when it
        // FINISHES and nothing in between, so a 40-minute test suite is 40
        // minutes of silence from a session that is plainly alive. Counting it
        // as progress is what lets real work run as long as it needs.
        if (session.status === "busy") lastProgressAt = Date.now();
        // `waiting` means a prompt or dialog is up. Its clock is separate: it
        // is not silence to be waited out, it is a state only a human can
        // leave, so it must not be reset by transcript growth.
        waitingSinceAt = session.status === "waiting" ? (waitingSinceAt ?? Date.now()) : null;
        if (session.status === "waiting") lastWaitingFor = session.waitingFor ?? lastWaitingFor;
        if (sessionFoundAt === null) {
          sessionFoundAt = Date.now();
          // Registration is itself progress; restart the idle clock from here
          // so slow startup isn't charged against the session's first tool.
          lastProgressAt = sessionFoundAt;
        }
        const raw = await readTranscript(homeDir, opts.cwd, session.sessionId);
        if (raw) {
          const st = parseTranscript(raw);
          // Any growth in the transcript is proof of life -- this is what makes
          // a long, healthy turn immune to the bound that killed issue #149's.
          if (st.entryCount > entryCount) {
            entryCount = st.entryCount;
            lastProgressAt = Date.now();
            lastTranscriptAt = lastProgressAt;
          }
          // Forward only the events that appeared since the last poll, so the
          // caller sees the real tool-call trail (as the one-shot `-p` path
          // narrates it) rather than a content-free ticker.
          for (const ev of st.events.slice(narratedEvents)) {
            sawTurnActivity = true;
            lastActivity = ev.message;
            emit(ev.message, ev.kind);
          }
          narratedEvents = st.events.length;
          // Emit the URL the moment it's known (well before completion) so the
          // caller posts the "watch it here" comment near the start of the run.
          if (st.bridgeSessionId) reportUrl(remoteControlUrlFromBridge(st.bridgeSessionId));
          if (st.turnComplete) {
            // A completed turn whose entire output is a credential complaint
            // is an auth failure, not work -- the CLI records "Login expired ·
            // Please run /login" as assistant text and then writes
            // `turn_duration` like any finished turn, so `turnComplete` alone
            // cannot be trusted here (see `isAuthFailureDisguisedAsSuccess`).
            if (isAuthFailureDisguisedAsSuccess(st.finalText)) {
              return {
                finalMessage: null,
                failed: true,
                failureDetail: st.finalText,
                authError: true,
                sessionId: session.sessionId,
              };
            }
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

      // Startup bound: no session yet means there is no transcript to measure
      // silence against, and a CLI wedged on an unexpected prompt never exits.
      if (sessionFoundAt === null && Date.now() - startedAt >= startupTimeoutMs) {
        return {
          finalMessage: null,
          failed: true,
          failureDetail:
            `The remote-control session never registered with the CLI within ${Math.round(startupTimeoutMs / 1000)}s. ` +
            (clip(ptyOutput.trim(), 600) || "The session produced no output."),
          authError: looksLikeAuthError(ptyOutput),
          sessionId: null,
        };
      }

      const silentForMs = Date.now() - lastProgressAt;
      if (sessionFoundAt !== null) {
        if (waitingSinceAt !== null && Date.now() - waitingSinceAt >= waitingTimeoutMs) {
          const blockedSecs = Math.round((Date.now() - waitingSinceAt) / 1000);
          return {
            finalMessage: null,
            failed: true,
            failureDetail:
              `The remote-control session is blocked waiting for input (${lastWaitingFor ?? "reason not reported"}) ` +
              `and nothing answered it for ${blockedSecs}s. Take over the session at its claude.ai URL to answer, or re-trigger with more detail in the request.`,
            authError: false,
            sessionId: discoveredSessionId,
          };
        }
        // Which bound applies is the session's own status, not a guess:
        //   busy    -> none; it is working, and duration is not our business
        //   waiting -> none here; handled above, on its own clock
        //   idle    -> a short grace, because "not working" is a real answer
        //   absent  -> the transcript-silence fallback, our only signal
        const bound =
          lastStatus === "busy" || lastStatus === "waiting"
            ? Infinity
            : lastStatus === "idle"
              ? idleStatusGraceMs
              : idleTimeoutMs;
        if (silentForMs >= bound) return idleFailure(silentForMs);
      }

      if (Date.now() >= absoluteDeadline) {
        return {
          finalMessage: null,
          failed: true,
          failureDetail: `Timed out after ${opts.maxWaitMs}ms waiting for the remote-control session to finish`,
          authError: false,
          sessionId: null,
        };
      }

      // Fires only when nothing else has been said for a full interval -- real
      // activity narrates itself above and pushes this out. What it reports is
      // the session's actual state, not a blanket "still running": the old
      // ticker said that about sessions that had already stopped.
      if (Date.now() - lastEmitAt >= heartbeatMs) {
        const secs = Math.round((Date.now() - lastTranscriptAt) / 1000);
        const heartbeatMessage =
          sessionFoundAt === null
            ? `still starting the remote-control session… (${secs}s)`
            : lastStatus === "waiting"
              ? `remote-control session is waiting for input (${lastWaitingFor ?? "reason not reported"})`
              : lastActivity
                ? `still running the remote-control session [${lastStatus ?? "status unknown"}] — quiet for ${secs}s since: ${clip(lastActivity, 120)}`
                : `still running the remote-control session [${lastStatus ?? "status unknown"}] — no activity yet (${secs}s)`;
        emit(heartbeatMessage, "agent");
      }

      await sleep(pollIntervalMs, opts.signal);
    }
  } finally {
    kill();
  }
}
