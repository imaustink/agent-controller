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
// flow (integration-gateway's claude-auth phase). Unconfirmed -- adjust after
// a real spike against a live CLI + subscription.
const REMOTE_CONTROL_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;

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
  id: string | null;
  url: string | null;
  finished: boolean;
  failed: boolean;
  resultText: string | null;
}

/**
 * Parses one entry from the (unconfirmed) `claude agents --json` array.
 * Guesses at plausible field names (`name`/`sessionName`, `status`/`state`,
 * `url`/`remoteControlUrl`, `result`/`output`/`message`) since there is no way
 * to inspect the real shape here. Every access is guarded so an entirely
 * different real shape degrades to "doesn't look finished yet" rather than
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
  const id = pickString("id", "sessionId", "session_id");
  const url = pickString("url", "remoteControlUrl", "remote_control_url", "link");
  const status = (pickString("status", "state") ?? "").toLowerCase();
  const resultText = pickString("result", "output", "message", "summary");
  const finished = ["completed", "finished", "done", "stopped", "exited", "ended"].includes(status);
  const failed =
    ["failed", "error", "errored"].includes(status) || rec.failed === true || rec.isError === true || rec.is_error === true;
  return { name, id, url, finished, failed, resultText };
}

/**
 * Finds the entry matching `sessionName` in a `claude agents --json` payload.
 * Tolerates the top-level value being either a bare array (per `--help`'s
 * "Print active sessions ... as a JSON array") or, in case that's imprecise,
 * an object wrapping the array under a `sessions` key -- and returns `null`
 * (never throws) for anything else, including malformed JSON.
 */
function findSessionByName(raw: string, sessionName: string): ParsedAgentSession | null {
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
    if (parsedEntry?.name === sessionName) return parsedEntry;
  }
  return null;
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

    const poll = await spawnAndCapture(["agents", "--json"], {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      mirrorStderr: false,
    });

    if (!poll.error) {
      const found = findSessionByName(poll.stdout, sessionName);
      if (found) {
        if (found.url) reportUrl(found.url);
        if (found.finished || found.failed) {
          const combined = `${found.resultText ?? ""}\n${poll.stderr}`;
          return {
            finalMessage: found.resultText,
            failed: found.failed,
            failureDetail: found.failed ? (found.resultText ?? "The remote-control session reported a failure") : null,
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
