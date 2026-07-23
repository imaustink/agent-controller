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
 */

const URL_RE = /(https:\/\/[^\s]+)/;
const TOKEN_RE = /(sk-ant-oat01-[A-Za-z0-9_-]+)/;

/** How long to wait for the authorize URL to appear after spawning. */
const URL_WAIT_TIMEOUT_MS = 30_000;
/** How long to wait for a token (or a clear error) after the code is submitted. */
const CODE_SUBMIT_TIMEOUT_MS = 30_000;
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
      cols: 120,
      rows: 30,
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
        cleanup();
        this.reap(flowId);
        reject(new Error("claude setup-token did not print an authorize URL in time"));
      }, URL_WAIT_TIMEOUT_MS);

      const check = (): void => {
        const match = flow.output.match(URL_RE);
        if (match) {
          cleanup();
          resolve({ flowId, authorizeUrl: match[1]! });
          return;
        }
        if (flow.exited) {
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
      const timer = setTimeout(
        () => finish({ status: "error", message: "Timed out waiting for a response after submitting the code." }),
        CODE_SUBMIT_TIMEOUT_MS,
      );
      const check = (): void => {
        const newOutput = flow.output.slice(outputBefore);
        const match = newOutput.match(TOKEN_RE);
        if (match) {
          finish({ status: "complete", token: match[1]! });
          return;
        }
        if (flow.exited) {
          finish({ status: "error", message: `claude setup-token exited without producing a token: ${clip(newOutput)}` });
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
