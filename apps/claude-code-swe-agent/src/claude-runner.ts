import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
// Remote Control path (`claude --bg --remote-control`).
//
// Everything below this point is built against flags confirmed to exist via
// `claude --help` (`--bg`/`--background`, `--remote-control [name]`,
// `claude agents --json`) but an UNCONFIRMED runtime contract: the exact
// stdout printed on handoff, the exact JSON shape `claude agents --json`
// returns, and how a finished/failed background session is distinguished from
// a still-running one. There is no way to verify any of this in this sandbox
// (no real Claude subscription login), so every guess is called out inline.
// The intent is that a human can re-point `scrapeRemoteControlUrl` and
// `parseAgentSessionEntry` at the real shapes after running one real spike,
// without needing to touch the polling/heartbeat/auth-classification
// scaffolding around them.
// ---------------------------------------------------------------------------

/** Cadence for polling `claude agents --json` while waiting for the background session to conclude. */
const REMOTE_CONTROL_POLL_INTERVAL_MS = 5_000;

/** Upper bound on how long to wait for a Remote Control session to conclude before giving up. */
const REMOTE_CONTROL_MAX_WAIT_MS = 30 * 60_000;

// Guess: the URL printed to stdout on `--bg --remote-control` handoff looks
// like the session URLs used elsewhere in this codebase's Remote Control login
// flow (integration-gateway's claude-auth phase).
//
// NOTE: `claude --bg` does NOT print this URL anywhere, and it is absent
// from `claude agents --json` too (both confirmed empirically). So this
// scrape almost never fires -- the URL is instead CONSTRUCTED from the
// session id (see `buildRemoteControlUrl`), which is how the CLI itself
// builds it. The scrape is kept only as a belt-and-braces first choice in
// case a future CLI version does start printing it.
const REMOTE_CONTROL_URL_RE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+/;

/**
 * Builds the Remote Control session URL from a session id, mirroring the
 * `claude` CLI's own construction (decompiled from v2.1.218:
 * `https://claude.ai/code/${toCompatSessionId(id)}`, where
 * `toCompatSessionId` rewrites only a `cse_`-prefixed id to `session_<rest>`
 * and passes everything else through unchanged). This is the reliable path
 * to the URL because the CLI never emits it in `--bg` mode -- we already
 * capture the session id from `claude agents --json --all`, so we can derive
 * the exact same URL a human would get from `/remote-control` interactively.
 * Returns null for an empty id.
 */
function buildRemoteControlUrl(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const compat = sessionId.startsWith("cse_") ? `session_${sessionId.slice(4)}` : sessionId;
  return `https://claude.ai/code/${compat}`;
}
/**
 * Confirmed empirically (real `claude --bg --remote-control` invocation,
 * see claude-runner-remote-control.test.ts): the initial handoff prints
 * `backgrounded · <shortId>` (the separator observed was a middle dot,
 * U+00B7 -- tolerating a bullet/hyphen too in case that varies by
 * terminal/version), and THIS short id -- NOT the `--remote-control <name>`
 * value we pass -- is what `claude agents --json`'s own `id` field holds.
 * The `name` field in that JSON is the prompt text, unrelated to the name
 * we passed. Matching on `name` (an earlier, unverified guess) meant the
 * poll loop below could never find its own session and looped forever.
 */
const BACKGROUNDED_ID_RE = /backgrounded\s*[·•-]\s*([A-Za-z0-9]+)/i;

function scrapeRemoteControlUrl(text: string): string | null {
  const match = text.match(REMOTE_CONTROL_URL_RE);
  return match ? match[0] : null;
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

interface ParsedAgentSession {
  name: string | null;
  /** The short id (e.g. "4ebeef3c") -- the CLI's own stable per-session identifier, confirmed via a real "backgrounded · <id>" handoff plus a matching `agents --json` "id" field. */
  id: string | null;
  /** The long UUID-shaped session id (e.g. "4ebeef3c-aca9-4f63-84b4-a503a95bbb12") -- distinct from `id` above; this is what names the session's own JSONL transcript file under `~/.claude/projects/<hashed-cwd>/`. */
  longSessionId: string | null;
  url: string | null;
  finished: boolean;
  failed: boolean;
  resultText: string | null;
}

/**
 * Parses one entry from a real (confirmed via a throwaway local session,
 * see claude-runner-remote-control.test.ts) `claude agents --json` array
 * entry. Two confirmed surprises this now accounts for:
 *
 * 1. A finished background session reports `status: "idle"` (an activity
 *    indicator, not a lifecycle one) alongside the ACTUAL lifecycle signal
 *    in a separate `state` field (`"done"`, or `"blocked"` when stuck e.g.
 *    on an auth failure) -- checking only one of the two fields (an earlier
 *    version of this code picked whichever was present first) missed
 *    exactly the real-world "status idle, state done" combination, so a
 *    genuinely finished session was never detected as finished.
 * 2. There is no `result`/`output`/`message`/`summary` field at all --
 *    `resultText` legitimately stays `null` for a real finished session;
 *    the caller must read the session's own JSONL transcript (see
 *    `readFinalMessageFromTranscript`) to get the actual final reply text.
 *
 * Every access is still guarded so an entirely different real shape (a
 * future CLI version) degrades to "doesn't look finished yet" rather than
 * throwing -- a parse surprise should never crash the run, only delay
 * detecting completion until the next poll or the maxWait timeout.
 */
function parseAgentSessionEntry(entry: unknown): ParsedAgentSession | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  const pickString = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value) return value;
    }
    return null;
  };
  const name = pickString("name", "sessionName", "session_name");
  const id = pickString("id");
  const longSessionId = pickString("sessionId", "session_id");
  const url = pickString("url", "remoteControlUrl", "remote_control_url", "link");
  const status = (pickString("status") ?? "").toLowerCase();
  const state = (pickString("state") ?? "").toLowerCase();
  const resultText = pickString("result", "output", "message", "summary");
  const TERMINAL_DONE = ["completed", "finished", "done", "stopped", "exited", "ended"];
  const TERMINAL_FAILED = ["failed", "error", "errored"];
  const finished = TERMINAL_DONE.includes(status) || TERMINAL_DONE.includes(state);
  const failed =
    TERMINAL_FAILED.includes(status) ||
    TERMINAL_FAILED.includes(state) ||
    rec.failed === true ||
    rec.isError === true ||
    rec.is_error === true;
  return { name, id, longSessionId, url, finished, failed, resultText };
}

/**
 * Finds the entry for this run in a `claude agents --json` payload. Matches
 * by `id` (the short id scraped from the initial handoff's "backgrounded ·
 * <id>" line, e.g. "dd527d1c") when known -- confirmed empirically that
 * this is the CLI's own stable identifier for the session, unlike `name`
 * (which is the prompt text, not the `--remote-control <name>` value we
 * pass -- matching on that, an earlier unverified guess, meant this could
 * never find its own session at all). Falls back to matching on
 * `sessionName` only if the id was never captured, purely as a defensive
 * last resort. Tolerates the top-level value being either a bare array (per
 * `--help`'s "Print active sessions ... as a JSON array") or, in case
 * that's imprecise, an object wrapping the array under a `sessions` key --
 * and returns `null` (never throws) for anything else, including malformed
 * JSON.
 */
function findSession(raw: string, ids: { backgroundedId: string | null; sessionName: string }): ParsedAgentSession | null {
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
    const parsedEntry = parseAgentSessionEntry(entry);
    if (!parsedEntry) continue;
    if (ids.backgroundedId ? parsedEntry.id === ids.backgroundedId : parsedEntry.name === ids.sessionName) {
      return parsedEntry;
    }
  }
  return null;
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
 * Reads the final assistant message out of a finished background session's
 * own JSONL transcript (`~/.claude/projects/<hashed-cwd>/<longSessionId>.jsonl`)
 * -- necessary because `claude agents --json` never includes a result/output/
 * message field for a finished session (confirmed empirically), unlike the
 * one-shot `-p --output-format stream-json` path's `result` event. Returns
 * the LAST `type: "assistant"` entry's concatenated text content, or `null`
 * if the file can't be read/parsed or contains no assistant text -- treated
 * as "no result text available" by the caller, not a hard failure.
 */
async function readFinalMessageFromTranscript(homeDir: string, cwd: string, longSessionId: string): Promise<string | null> {
  const path = join(homeDir, ".claude", "projects", claudeProjectDirName(cwd), `${longSessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let lastText: string | null = null;
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
    if (rec.type !== "assistant") continue;
    const message = rec.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
    const text = content
      .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text)
      .join("");
    if (text) lastText = text;
  }
  return lastText;
}

/**
 * Runs one turn via `claude --bg --remote-control`, the alternative to
 * `runClaudeTurn`'s one-shot `-p` invocation used when Remote Control is
 * enabled for the Agent (see config.ts's `remoteControlEnabled` / the Go/Helm
 * init-container phase that seeds `~/.claude/.credentials.json` beforehand).
 *
 * `--bg` returns immediately after handing off to a background-managed
 * session (per `--help`), so unlike `runClaudeTurn` there is no single
 * long-lived child whose stdout can be parsed for completion. Instead this:
 *   1. spawns the handoff, best-effort-scrapes a Remote Control URL from
 *      whatever it prints, and surfaces it via `onProgress` as soon as known;
 *   2. polls `claude agents --json` on an interval (mirroring the existing
 *      heartbeat cadence) for the named session, parsing defensively since the
 *      real JSON shape is unconfirmed (see `parseAgentSessionEntry`);
 *   3. resolves with the same `ClaudeRunResult` shape as `runClaudeTurn` once
 *      that session reports finished, or after `maxWaitMs` elapses.
 */
export async function runClaudeTurnRemoteControlled(
  prompt: string,
  opts: RemoteControlRunOptions,
): Promise<ClaudeRunResult> {
  // Deterministic, unique-per-run session name so the poll below can find
  // exactly this session rather than guessing by recency/prompt text.
  const sessionName = `swe-${opts.runId}`;

  // Flag order/positioning mirrors `runClaudeTurn`'s where possible, but the
  // overall shape here is a guess: `--help` confirms `--bg` and
  // `--remote-control [name]` exist, but not where the prompt goes for a
  // background/remote-controlled session (there is no `-p` in this mode).
  // Assuming it's a trailing positional argument, same as an ordinary
  // interactive `claude <prompt>` invocation.
  const args = [
    "--bg",
    "--remote-control",
    sessionName,
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    JSON.stringify(opts.settings),
  ];
  if (opts.model) args.push("--model", opts.model);
  args.push(prompt);

  let urlReported = false;
  const reportUrl = (url: string): void => {
    if (urlReported) return;
    urlReported = true;
    logProgress("remote-control-url", url);
    opts.onProgress?.(url, "remote-control-url");
  };

  const initial = await spawnAndCapture(args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, mirrorStderr: true });
  if (initial.error) {
    return {
      finalMessage: null,
      failed: true,
      failureDetail: initial.error.message,
      authError: looksLikeAuthError(initial.error.message),
      sessionId: null,
    };
  }

  const initialUrl = scrapeRemoteControlUrl(initial.stdout) ?? scrapeRemoteControlUrl(initial.stderr);
  if (initialUrl) reportUrl(initialUrl);

  // The actual, reliable key for finding this session again on a later
  // `claude agents --json` poll -- see BACKGROUNDED_ID_RE's doc. `null` if
  // the handoff's output didn't match (unconfirmed format change, or a
  // startup failure below), in which case polling falls back to matching on
  // `sessionName` against the (wrong, but better than nothing) `name` field.
  const backgroundedId =
    (initial.stdout.match(BACKGROUNDED_ID_RE)?.[1] ?? initial.stderr.match(BACKGROUNDED_ID_RE)?.[1]) || null;

  if (initial.code !== 0) {
    const combined = `${initial.stdout}\n${initial.stderr}`;
    return {
      finalMessage: null,
      failed: true,
      failureDetail: clip(initial.stderr.trim() || `claude exited with code ${initial.code ?? "null"}`, 800),
      authError: looksLikeAuthError(combined),
      sessionId: null,
    };
  }

  const pollIntervalMs = opts.pollIntervalMs ?? REMOTE_CONTROL_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? REMOTE_CONTROL_MAX_WAIT_MS;
  const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const deadline = Date.now() + maxWaitMs;
  let lastHeartbeatAt = Date.now();

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return {
        finalMessage: null,
        failed: true,
        failureDetail: "Aborted while waiting for the remote-control session to conclude",
        authError: false,
        sessionId: null,
      };
    }

    // `--all` is REQUIRED, not optional: confirmed empirically (a real
    // logged-in `--bg --remote-control` session, driven under a pipe exactly
    // as spawned here) that plain `claude agents --json` returns `[]` the
    // instant a session leaves the running state -- a terminated session
    // (whether `state: "done"` or `state: "failed"`) is omitted entirely
    // unless `--all` is passed (`claude agents --help`: "--all  With --json:
    // also include completed background sessions"). Without it, a session
    // that finishes between two polls (or faster than the first poll) simply
    // vanishes from the list and this loop waits until `maxWaitMs` -- THE
    // actual cause of every Remote Control run hanging to the Job timeout.
    const poll = await spawnAndCapture(["agents", "--json", "--all"], {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      mirrorStderr: false,
    });

    if (!poll.error) {
      const found = findSession(poll.stdout, { backgroundedId, sessionName });
      if (found) {
        // The URL is essentially always constructed, not scraped: the CLI
        // doesn't expose it in `agents --json`. Emit it the moment the
        // session first appears in a poll (running or done) so the caller
        // can post the "work started, watch it here" comment near the start
        // of the run, which is the whole point of the feature. `found.url`
        // is preferred only if a future CLI version ever populates one.
        const url = found.url ?? buildRemoteControlUrl(found.longSessionId ?? found.id);
        if (url) reportUrl(url);
        if (found.finished || found.failed) {
          // `agents --json` never includes a result/output/message field for
          // a finished session (confirmed empirically) -- fall back to the
          // session's own JSONL transcript for the actual final reply text.
          const resultText =
            found.resultText ??
            (found.longSessionId ? await readFinalMessageFromTranscript(opts.env.HOME ?? "", opts.cwd, found.longSessionId) : null);
          const combined = `${resultText ?? ""}\n${poll.stderr}`;
          return {
            finalMessage: resultText,
            failed: found.failed,
            failureDetail: found.failed ? (resultText ?? "The remote-control session reported a failure") : null,
            authError: found.failed && looksLikeAuthError(combined),
            sessionId: found.id,
          };
        }
      }
    }
    // A poll spawn error or an unparseable/unmatched payload is treated as
    // "still in progress" rather than a hard failure -- see the module
    // doc-comment above for why: a transient poll hiccup shouldn't fail a run
    // that's genuinely still going, and `maxWaitMs` is the real backstop.

    if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = Date.now();
      const heartbeatMessage = `still waiting for the remote-control session "${sessionName}" to finish…`;
      logProgress("agent", heartbeatMessage);
      opts.onProgress?.(heartbeatMessage, "agent");
    }

    await sleep(pollIntervalMs, opts.signal);
  }

  return {
    finalMessage: null,
    failed: true,
    failureDetail: `Timed out after ${maxWaitMs}ms waiting for the remote-control session "${sessionName}" to conclude`,
    authError: false,
    sessionId: null,
  };
}
