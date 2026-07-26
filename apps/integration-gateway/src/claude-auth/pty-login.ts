import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";

/**
 * Drives `claude auth login --claudeai` (Claude Code's full-login flow,
 * needed for "Remote Control" -- see docs/adr/0027's follow-up) via a PTY,
 * sibling to `pty-setup-token.ts`'s `ClaudeSetupTokenFlows` and structurally
 * near-identical to it (same flowId/idle-reap/Flow-map shape, same OSC-8/ANSI
 * url scraping, same paced code-paste-then-submit) -- kept as a parallel file
 * rather than a shared abstraction because the two commands' terminal output
 * and success signal differ enough, and because `claude-auth/` is itself
 * already a sibling to `identity-link/` for the same reason (see that
 * directory's own doc comments): duplication here is the established style
 * for auth mechanics that differ, not an oversight.
 *
 * The key mechanical difference from `pty-setup-token.ts`: `claude setup-token`
 * prints its result (an OAuth token) straight to stdout, but `claude auth
 * login --claudeai` instead WRITES a full credential file to
 * `~/.claude/.credentials.json` and prints only a human success message. To
 * capture that file without ever touching the gateway container's own real
 * `~/.claude/.credentials.json` (which would silently overwrite this
 * process's own Claude Code auth, if any), each flow gets its own scratch
 * `HOME` under `os.tmpdir()``, the child is spawned with `HOME` pointed at
 * it, and the file is read back from `<scratchHome>/.claude/.credentials.json`
 * once the CLI reports success -- then the scratch directory is deleted.
 *
 * IMPORTANT CAVEAT (unlike `pty-setup-token.ts`'s regexes, which were
 * confirmed empirically against a real PTY -- see that file's header): the
 * exact literal success/error text `claude auth login --claudeai` prints is
 * NOT confirmed against a real run. `LOGIN_SUCCESS_RE`/`LOGIN_ERROR_RE` below
 * are best-effort guesses at plausible CLI wording. Re-verify both against
 * the actual CLI output (same way pty-setup-token.ts's header describes doing
 * for `setup-token`) before relying on this in production, and expect to
 * adjust the regexes once the real text is known.
 */
const OSC8_URL_RE = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)\x07/;
const URL_RE = /(https:\/\/[^\s\x07\x1b]+)/;
/** Best-effort, UNCONFIRMED -- see file header caveat. */
const LOGIN_SUCCESS_RE = /(login successful|logged in successfully|successfully logged in|you(?:'|’)re now logged in|authentication successful)/i;
/** Best-effort, UNCONFIRMED -- see file header caveat. */
const LOGIN_ERROR_RE = /(login failed|authentication failed|invalid code|error:\s*[^\r\n\x1b]+)/i;

/** Mirrors `pty-setup-token.ts`'s `PTY_COLS` -- wide enough that nothing the CLI prints (URL, prompts, success text) ever hard-wraps and gets escape-spliced mid-value. Same empirical reasoning applies even though this file's own regexes are unconfirmed. */
const PTY_COLS = 512;

/** Mirrors `pty-setup-token.ts`'s `stripAnsi` -- strips OSC/CSI escape sequences so a color/cursor escape adjacent to a value can't hide it from a regex. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (BEL- or ST-terminated)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (SGR color, cursor movement, etc.)
    .replace(/\x1b[@-Z\\-_]/g, ""); // lone 2-byte C1 escapes
}

function extractAuthorizeUrl(output: string): string | undefined {
  return (output.match(OSC8_URL_RE)?.[1]) ?? stripAnsi(output).match(URL_RE)?.[1];
}

/** How long to wait for the authorize URL to appear after spawning. Same value as `pty-setup-token.ts`; adjust independently if `login`'s startup turns out slower/faster. */
const URL_WAIT_TIMEOUT_MS = 30_000;
/** How long to wait for a success/error signal after the code is submitted. See `pty-setup-token.ts`'s `CODE_SUBMIT_TIMEOUT_MS` doc for why this is generous rather than tight. */
const CODE_SUBMIT_TIMEOUT_MS = 60_000;
/** Hard ceiling on how long a flow can sit unattended between `start` and `submitCode` before it's reaped. */
const FLOW_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Delay between writing the pasted code and writing the Enter keypress -- see `pty-setup-token.ts`'s `PASTE_SUBMIT_DELAY_MS` doc; same Ink-TUI paste-vs-submit ambiguity is assumed to apply here too until proven otherwise. */
const PASTE_SUBMIT_DELAY_MS = 500;
/** Code fed in paced chunks, not one write -- see `pty-setup-token.ts`'s `CODE_CHUNK_SIZE`/`CODE_CHUNK_GAP_MS` doc for why. */
const CODE_CHUNK_SIZE = 16;
const CODE_CHUNK_GAP_MS = 30;

export type SubmitCodeResult = { status: "complete"; token: string } | { status: "error"; message: string };

interface Flow {
  proc: pty.IPty;
  subject: string;
  output: string;
  exited: boolean;
  killed: boolean;
  /** Per-flow scratch `HOME` -- see file header. Removed (recursively, best-effort) whenever the flow is reaped, whether it succeeded, errored, or was abandoned. */
  scratchHome: string;
  idleTimer: ReturnType<typeof setTimeout>;
  /** Same listener-fanout shape as `pty-setup-token.ts`'s `Flow.listeners` -- see that file's doc comment for why a single persistent subscription feeds multiple independent waiters instead of `start()` tearing it down early. */
  listeners: Set<() => void>;
}

/**
 * Manages in-flight `claude auth login --claudeai` PTY sessions, keyed by a
 * server-generated `flowId` -- in-memory only, same non-durability posture as
 * `ClaudeSetupTokenFlows` (see its class doc): the live subprocess, its open
 * stdin, and its scratch `HOME` directory are all inherently local state that
 * can't survive a restart.
 */
export class ClaudeLoginFlows {
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly spawnImpl: typeof pty.spawn = pty.spawn) {}

  /** Spawns `claude auth login --claudeai` (with an isolated scratch `HOME`, see file header) and resolves once its authorize URL appears in the PTY output. */
  start(subject: string): Promise<{ flowId: string; authorizeUrl: string }> {
    const flowId = randomUUID();
    const scratchHome = mkdtempSync(path.join(os.tmpdir(), "claude-login-"));
    const proc = this.spawnImpl("claude", ["auth", "login", "--claudeai"], {
      name: "xterm-color",
      cols: PTY_COLS,
      rows: 50,
      env: { ...process.env, HOME: scratchHome } as Record<string, string>,
    });

    const flow: Flow = {
      proc,
      subject,
      output: "",
      exited: false,
      killed: false,
      scratchHome,
      idleTimer: setTimeout(() => this.reap(flowId), FLOW_IDLE_TIMEOUT_MS),
      listeners: new Set(),
    };
    this.flows.set(flowId, flow);

    // Permanent for the flow's whole life -- see the doc comment on `Flow.listeners`.
    proc.onData((chunk) => {
      flow.output += chunk;
      for (const listener of flow.listeners) listener();
    });
    proc.onExit(() => {
      flow.exited = true;
      for (const listener of flow.listeners) listener();
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error(`[claude-auth] login start() timed out waiting for the authorize URL for flow ${flowId} -- redacted output:\n${redactSecrets(flow.output)}`);
        cleanup();
        this.reap(flowId);
        reject(new Error("claude auth login did not print an authorize URL in time"));
      }, URL_WAIT_TIMEOUT_MS);

      const check = (): void => {
        const authorizeUrl = extractAuthorizeUrl(flow.output);
        if (authorizeUrl) {
          cleanup();
          resolve({ flowId, authorizeUrl });
          return;
        }
        if (flow.exited) {
          console.error(`[claude-auth] login start() process exited before printing a URL for flow ${flowId} -- redacted output:\n${redactSecrets(flow.output)}`);
          cleanup();
          this.reap(flowId);
          reject(new Error(`claude auth login exited before printing an authorize URL: ${clip(flow.output)}`));
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        flow.listeners.delete(check);
      };

      flow.listeners.add(check);
      check(); // in case output/exit already happened synchronously before this listener was registered
    });
  }

  /** The subject a still-live flow was started for -- same purpose as `ClaudeSetupTokenFlows.getSubject`. */
  getSubject(flowId: string): string | undefined {
    return this.flows.get(flowId)?.subject;
  }

  /**
   * Writes the pasted authorization code to the flow's stdin and waits
   * (bounded) for a success/error signal. On success, reads back
   * `<scratchHome>/.claude/.credentials.json`'s contents as the resolved
   * "token" (really a JSON credentials blob -- see file header), then removes
   * the scratch directory.
   */
  submitCode(flowId: string, code: string): Promise<SubmitCodeResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return Promise.resolve({ status: "error", message: "This authorization link has expired. Please try again." });

    clearTimeout(flow.idleTimer);
    const outputBefore = flow.output.length;

    // Same paced-chunk-then-separate-Enter feed as `pty-setup-token.ts`'s
    // `submitCode` -- see that file's doc comment for the two empirically
    // confirmed reasons this shape is required for `setup-token`. Applied here
    // defensively since both commands share the same Ink-TUI-driven CLI.
    let chunkTimer: ReturnType<typeof setTimeout> | undefined;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    const feedCode = (): void => {
      let i = 0;
      const writeNext = (): void => {
        if (flow.killed) return;
        if (i < code.length) {
          flow.proc.write(code.slice(i, i + CODE_CHUNK_SIZE));
          i += CODE_CHUNK_SIZE;
          chunkTimer = setTimeout(writeNext, CODE_CHUNK_GAP_MS);
        } else {
          enterTimer = setTimeout(() => {
            if (!flow.killed) flow.proc.write("\r");
          }, PASTE_SUBMIT_DELAY_MS);
        }
      };
      writeNext();
    };
    feedCode();

    return new Promise((resolve) => {
      const finish = (result: SubmitCodeResult): void => {
        cleanup();
        this.reap(flowId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        console.error(
          `[claude-auth] login submitCode timed out for flow ${flowId} -- redacted output since last write:\n${redactSecrets(flow.output.slice(outputBefore))}`,
        );
        finish({ status: "error", message: "Timed out waiting for a response after submitting the code." });
      }, CODE_SUBMIT_TIMEOUT_MS);
      const check = (): void => {
        const newOutput = stripAnsi(flow.output.slice(outputBefore));
        if (LOGIN_SUCCESS_RE.test(newOutput)) {
          let credentialsJson: string;
          try {
            credentialsJson = readFileSync(path.join(flow.scratchHome, ".claude", ".credentials.json"), "utf8");
          } catch (err) {
            console.error(`[claude-auth] login: CLI reported success but no credentials file was found for flow ${flowId}:`, err instanceof Error ? err.message : String(err));
            finish({ status: "error", message: "claude auth login reported success but did not produce a credentials file." });
            return;
          }
          finish({ status: "complete", token: credentialsJson });
          return;
        }
        const loginError = newOutput.match(LOGIN_ERROR_RE);
        if (loginError) {
          console.error(`[claude-auth] login submitCode error for flow ${flowId}: ${loginError[1]!.trim()}`);
          finish({ status: "error", message: `Login error: ${loginError[1]!.trim()}` });
          return;
        }
        if (flow.exited) {
          console.error(`[claude-auth] login submitCode: process exited without success for flow ${flowId} -- redacted output:\n${redactSecrets(newOutput)}`);
          finish({ status: "error", message: `claude auth login exited without completing: ${clip(redactSecrets(newOutput))}` });
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        if (chunkTimer) clearTimeout(chunkTimer);
        if (enterTimer) clearTimeout(enterTimer);
        flow.listeners.delete(check);
      };

      flow.listeners.add(check);
      check(); // in case success/error already arrived (or the process already exited) before this listener was registered
    });
  }

  private reap(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.killed) return;
    flow.killed = true;
    clearTimeout(flow.idleTimer);
    flow.listeners.clear();
    try {
      flow.proc.kill();
    } catch {
      // already exited
    }
    try {
      rmSync(flow.scratchHome, { recursive: true, force: true });
    } catch (err) {
      console.error(`[claude-auth] login: failed to remove scratch HOME for flow ${flowId} (ignored):`, err instanceof Error ? err.message : String(err));
    }
    this.flows.delete(flowId);
  }
}

function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Same purpose as `pty-setup-token.ts`'s `redactSecrets` -- masks anything Anthropic-secret-shaped before it's ever logged. */
function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, (m) => `${m.slice(0, 12)}…[REDACTED len=${m.length}]`);
}
