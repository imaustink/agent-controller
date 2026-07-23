import { randomUUID } from "node:crypto";
import * as pty from "node-pty";

/**
 * Drives `claude setup-token` (docs/adr/0027) via a PTY -- it's an
 * interactive TUI (confirmed via `claude setup-token --help`, which offers
 * no non-interactive flags at all), so a plain piped `child_process.spawn`
 * (as every other subprocess in this repo uses, e.g.
 * apps/opencode-swe-agent/src/opencode-server.ts) won't work: the CLI
 * detects a non-TTY stdout and may behave differently, and even if it
 * didn't, there'd be no way to interactively supply the pasted
 * authorization code partway through. `node-pty` is a new dependency for
 * this reason -- no other subprocess in this codebase writes to a child's
 * stdin interactively.
 *
 * The exact TUI text (the authorize URL's surrounding wording, the prompt
 * for the code, the final token line) is NOT a stable API across Claude
 * Code CLI versions -- pin the version wherever this actually runs and
 * re-verify these regexes whenever it's bumped, same caveat as
 * claude-code-swe-agent's own `claude-runner.ts`.
 *
 * Confirmed empirically (CLI v2.1.218, by actually spawning it in a real PTY
 * and inspecting the raw bytes -- this whole file was originally written
 * from `claude setup-token --help` alone, which does NOT describe any of
 * this): the CLI renders the authorize URL as a real terminal hyperlink --
 * `ESC ] 8 ; id=<id> ; <full url> BEL` (OSC 8) -- immediately followed by a
 * human-readable fallback rendering of the SAME url, wrapped across several
 * cursor-positioned terminal cells for non-hyperlink-aware terminals. A
 * naive "https://\S+" match runs straight through the OSC 8 escapes with no
 * whitespace to stop at, concatenating the real url with fragments of the
 * wrapped duplicate into one garbled string -- exactly what made every real
 * link unreliable. `OSC8_URL_RE` extracts the one authoritative copy from
 * inside the escape sequence itself; `URL_RE` is only a fallback for a CLI
 * build/terminal negotiation that doesn't emit OSC 8, and stops at the next
 * escape/BEL/whitespace rather than consuming everything after "https://".
 *
 * The same wrapping behaviour is why VALID codes timed out (the reported
 * "submit hangs then linking failed"): on success the CLI prints the
 * ~110-char `sk-ant-oat01-…` token (docs confirm setup-token prints it and
 * saves it nowhere), and at the old 120-col PTY width that token wrapped and
 * was redrawn with cursor-repositioning escapes spliced into it -- so unlike
 * the URL it had no OSC-8 clean copy to fall back on, and `TOKEN_RE` never
 * saw a contiguous match. The fix is {@link PTY_COLS}: make the PTY wide
 * enough that nothing the CLI prints ever wraps. See its doc.
 */
const OSC8_URL_RE = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)\x07/;
const URL_RE = /(https:\/\/[^\s\x07\x1b]+)/;
const TOKEN_RE = /(sk-ant-oat01-[A-Za-z0-9_-]+)/;
/** The CLI's own error text for a wrong/incomplete/expired pasted code (confirmed empirically -- see file header). Stops at CR/LF/ESC so the captured message is a clean single line, not the rest of the redrawn prompt. */
const OAUTH_ERROR_RE = /OAuth error: ([^\r\n\x1b]+)/;

/**
 * The PTY width, deliberately far wider than any line the CLI prints (its
 * longest is the ~346-char authorize URL; the token is ~110). This is THE
 * fix for tokens timing out on success: the CLI's Ink TUI hard-wraps output
 * to the terminal width and redraws wrapped lines with cursor-repositioning
 * escapes SPLICED INTO the value, so at the old 120-col width a ~110-char
 * token (plus any label/box padding) wrapped and `sk-ant-oat01-…` never
 * appeared as one contiguous, matchable run -> TOKEN_RE never matched ->
 * timeout. Confirmed empirically: at 120 cols the visible URL truncates to
 * exactly 120 chars; at 400+ it stays whole on one line. The authorize URL
 * survived narrow widths only because it ALSO ships as an OSC-8 hyperlink
 * (a clean out-of-band copy); the token has no such channel, so not wrapping
 * in the first place is the only robust option.
 */
const PTY_COLS = 512;

/**
 * Strips OSC (incl. OSC-8 hyperlink) and CSI (color/cursor) escape sequences,
 * leaving only visible text -- defense-in-depth on top of {@link PTY_COLS} so
 * a value still matches even if a color escape sits adjacent to it. Does NOT
 * (and cannot) reassemble a value that was split across wrapped lines by
 * cursor repositioning -- that's exactly what the wide PTY prevents upstream.
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (BEL- or ST-terminated)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (SGR color, cursor movement, etc.)
    .replace(/\x1b[@-Z\\-_]/g, ""); // lone 2-byte C1 escapes
}

function extractAuthorizeUrl(output: string): string | undefined {
  // OSC-8 hyperlink target first (always the full, untruncated url); fall
  // back to a plain-text match over escape-stripped output.
  return (output.match(OSC8_URL_RE)?.[1]) ?? stripAnsi(output).match(URL_RE)?.[1];
}

/** How long to wait for the authorize URL to appear after spawning. */
const URL_WAIT_TIMEOUT_MS = 30_000;
/**
 * How long to wait for a token (or a clear error) after the code is
 * submitted. A malformed code is rejected locally/near-instantly (confirmed
 * empirically), but a well-formed, network-validated code presumably takes
 * an actual round-trip to Anthropic -- widened from 30s while diagnosing a
 * real report of this timing out even for a correctly-copied code, in case
 * that's genuinely just slower than expected rather than actually stuck.
 */
const CODE_SUBMIT_TIMEOUT_MS = 60_000;
/** Hard ceiling on how long a flow can sit unattended between `start` and `submitCode` before it's reaped. */
const FLOW_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type SubmitCodeResult = { status: "complete"; token: string } | { status: "error"; message: string };

interface Flow {
  proc: pty.IPty;
  subject: string;
  output: string;
  exited: boolean;
  killed: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
  /**
   * Callbacks interested in "something changed" (new output, or exit) --
   * `start()`'s wait-for-URL and `submitCode()`'s wait-for-token logic each
   * register their own here and remove ONLY their own entry once satisfied.
   * Deliberately separate from the single persistent `proc.onData`/`onExit`
   * subscription below (registered once, for the flow's whole life) -- a
   * previous version had `start()` dispose that subscription itself the
   * moment it found the URL, which stopped `flow.output` from ever growing
   * again and made every `submitCode()` call hang until its own timeout,
   * since it had nothing new to see. Never make that mistake again: nothing
   * but `reap()` may ever tear down the data/exit subscription.
   */
  listeners: Set<() => void>;
}

/**
 * Manages in-flight `claude setup-token` PTY sessions, keyed by a
 * server-generated `flowId` -- deliberately in-memory only (not Redis-backed
 * like {@link ClaudeTokenStore}): the live subprocess and its open stdin are
 * inherently local, in-process state that can't be serialized/resumed across
 * a restart, so this never claims to survive one. A flow that's abandoned
 * (URL never visited, code never pasted) is reaped by `FLOW_IDLE_TIMEOUT_MS`
 * regardless.
 */
export class ClaudeSetupTokenFlows {
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly spawnImpl: typeof pty.spawn = pty.spawn) {}

  /** Spawns `claude setup-token` and resolves once its authorize URL appears in the PTY output. */
  start(subject: string): Promise<{ flowId: string; authorizeUrl: string }> {
    const flowId = randomUUID();
    const proc = this.spawnImpl("claude", ["setup-token"], {
      name: "xterm-color",
      cols: PTY_COLS,
      rows: 50,
      env: process.env as Record<string, string>,
    });

    const flow: Flow = {
      proc,
      subject,
      output: "",
      exited: false,
      killed: false,
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
        console.error(`[claude-auth] start() timed out waiting for the authorize URL for flow ${flowId} -- redacted output:\n${redactSecrets(flow.output)}`);
        cleanup();
        this.reap(flowId);
        reject(new Error("claude setup-token did not print an authorize URL in time"));
      }, URL_WAIT_TIMEOUT_MS);

      const check = (): void => {
        const authorizeUrl = extractAuthorizeUrl(flow.output);
        if (authorizeUrl) {
          cleanup();
          resolve({ flowId, authorizeUrl });
          return;
        }
        if (flow.exited) {
          console.error(`[claude-auth] start() process exited before printing a URL for flow ${flowId} -- redacted output:\n${redactSecrets(flow.output)}`);
          cleanup();
          this.reap(flowId);
          reject(new Error(`claude setup-token exited before printing an authorize URL: ${clip(flow.output)}`));
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

  /** The subject a still-live flow was started for -- lets the API layer know whose store entry to write once `submitCode` succeeds, without the browser's code-paste form needing to carry it. */
  getSubject(flowId: string): string | undefined {
    return this.flows.get(flowId)?.subject;
  }

  /** Writes the pasted authorization code to the flow's stdin and waits (bounded) for the resulting token or a clear error. */
  submitCode(flowId: string, code: string): Promise<SubmitCodeResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return Promise.resolve({ status: "error", message: "This authorization link has expired. Please try again." });

    clearTimeout(flow.idleTimer);
    const outputBefore = flow.output.length;
    flow.proc.write(`${code}\r`);

    return new Promise((resolve) => {
      const finish = (result: SubmitCodeResult): void => {
        cleanup();
        this.reap(flowId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // Diagnostic only (docs/adr/0027 follow-up): a real, correctly-typed
        // code was reported to still hit this exact timeout in production,
        // meaning the CLI's actual success (or its own error) text doesn't
        // match TOKEN_RE/OAUTH_ERROR_RE the way the empirically-confirmed
        // "wrong code" case did. Logging the redacted raw output here is the
        // fastest way to see the real text and fix the regex, without
        // needing to `kubectl exec` into a live pod again for every retry.
        console.error(
          `[claude-auth] submitCode timed out for flow ${flowId} -- redacted output since last write:\n${redactSecrets(flow.output.slice(outputBefore))}`,
        );
        finish({ status: "error", message: "Timed out waiting for a response after submitting the code." });
      }, CODE_SUBMIT_TIMEOUT_MS);
      const check = (): void => {
        // Match against escape-stripped output so a color/cursor escape
        // adjacent to the value can't hide it (the wide PTY already prevents
        // the worse case -- an escape spliced mid-value by line wrapping).
        const newOutput = stripAnsi(flow.output.slice(outputBefore));
        const match = newOutput.match(TOKEN_RE);
        if (match) {
          finish({ status: "complete", token: match[1]! });
          return;
        }
        // On a wrong/incomplete code the CLI prints this and waits for
        // "Enter" to retry -- it neither exits nor prints a token, so
        // without this check the caller would sit through the full
        // CODE_SUBMIT_TIMEOUT_MS for the single most common failure mode
        // (a mistyped/truncated paste), which reads exactly like a hang.
        // Confirmed empirically (see file header) -- treated as terminal for
        // this flow (kill and require restarting the link) rather than
        // trying to support the CLI's own in-place retry.
        const oauthError = newOutput.match(OAUTH_ERROR_RE);
        if (oauthError) {
          finish({ status: "error", message: `OAuth error: ${oauthError[1]!.trim()}` });
          return;
        }
        if (flow.exited) {
          console.error(`[claude-auth] submitCode: process exited without a token for flow ${flowId} -- redacted output:\n${redactSecrets(newOutput)}`);
          finish({ status: "error", message: `claude setup-token exited without producing a token: ${clip(redactSecrets(newOutput))}` });
        }
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        flow.listeners.delete(check);
      };

      flow.listeners.add(check);
      check(); // in case the token already arrived (or the process already exited) before this listener was registered
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
    this.flows.delete(flowId);
  }
}

function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Masks anything Anthropic-secret-shaped before it's ever logged (diagnostic
 * logging only, see `submitCode`'s timeout handler) -- keeps enough of the
 * prefix to identify the credential's format/shape without leaking the full
 * value, in case the real success text turns out to use a different token
 * prefix than the `sk-ant-oat01-` this file assumed.
 */
function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, (m) => `${m.slice(0, 12)}…[REDACTED len=${m.length}]`);
}
