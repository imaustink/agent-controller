import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeTurnRemoteControlled } from "./claude-runner.js";

/**
 * The interactive Remote Control path (see the "Remote Control path" comment
 * in claude-runner.ts) orchestrates two real binaries -- `script` (which
 * pty-launches the interactive `claude --remote-control` session) and
 * `claude agents --json --all` (to discover our session id) -- plus the
 * session's own JSONL transcript on disk. These fakes stand in for both,
 * reproducing the exact shapes confirmed against the real CLI:
 *   - `script` writes the transcript (bridgeSessionId + assistant text +
 *     turn_duration) to the path the runner reads, then stays resident like a
 *     real interactive session until killed;
 *   - `claude agents --json --all` returns our session as `kind: "interactive"`
 *     at our cwd.
 * Behavior is driven by env vars so one pair of fakes covers every case.
 */
let binDir: string;
let homeDir: string;
let cwd: string;

const FAKE_SID = "11111111-2222-3333-4444-555555555555";

async function installFake(name: string, body: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
}

// Fake `script -q -c <wrapper> /dev/null`: simulate the interactive session by
// writing its transcript, then stay alive until the runner kills us.
//
// Modes:
//   complete  - bridge line + assistant text + turn_duration, written at once
//   running   - bridge line + assistant text, never completes (works, then wedges)
//   stalled   - bridge line only (registers, but the turn never begins)
//   streaming - bridge line, then a tool_use entry every FAKE_STEP_MS for
//               FAKE_STEPS steps, then assistant text + turn_duration. Models a
//               long but healthy turn -- the case issue #149 killed.
//   nofile    - no transcript at all
//
// The sentinel file matters: a real session does not appear in `claude agents`
// until its process is running, and the runner now snapshots the pre-existing
// sessions before it spawns. A fake that listed the session unconditionally
// would claim our own session already existed before we started it.
const FAKE_SCRIPT = `
const fs = require("fs"), path = require("path");
const HOME = process.env.HOME, SID = process.env.FAKE_SID;
// Use the exact cwd string the runner uses (FAKE_SESSION_CWD === opts.cwd), NOT
// process.cwd() -- on macOS the latter resolves /var -> /private/var and the
// path hash would then differ from what the runner reads (a test-only quirk;
// Linux/production has no such symlink).
const dir = path.join(HOME, ".claude", "projects", process.env.FAKE_SESSION_CWD.replace(/[/.]/g, "-"));
const file = path.join(dir, SID + ".jsonl");
const mode = process.env.FAKE_SCRIPT_MODE || "complete";
const assistant = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (name, i) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t" + i, name, input: {} }] } });
const done = () => JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 });
const bridge = () => JSON.stringify({ type: "summary", bridgeSessionId: "cse_TESTBRIDGE", lastSequenceNum: 0 });

// Announce that this session now exists (see comment above).
fs.writeFileSync(path.join(HOME, "session-started"), "1");
if (process.env.FAKE_SCRIPT_OUTPUT) process.stdout.write(process.env.FAKE_SCRIPT_OUTPUT);

if (mode !== "nofile") {
  fs.mkdirSync(dir, { recursive: true });
  if (mode === "streaming") {
    fs.writeFileSync(file, bridge() + "\\n");
    const stepMs = Number(process.env.FAKE_STEP_MS || 40);
    const steps = Number(process.env.FAKE_STEPS || 15);
    let i = 0;
    const timer = setInterval(() => {
      if (++i <= steps) { fs.appendFileSync(file, toolUse("Bash", i) + "\\n"); return; }
      clearInterval(timer);
      fs.appendFileSync(file, assistant(process.env.FAKE_ASSISTANT_TEXT || "DONE") + "\\n" + done() + "\\n");
    }, stepMs);
  } else {
    const lines = [bridge()];
    if (mode !== "stalled") lines.push(assistant(process.env.FAKE_ASSISTANT_TEXT || "DONE"));
    if (mode === "complete") lines.push(done());
    fs.writeFileSync(file, lines.join("\\n") + "\\n");
  }
}
if (process.env.FAKE_SCRIPT_EXIT === "1") process.exit(0);
setInterval(() => {}, 1e9);
`;

// Fake `claude`: only `agents --json --all` is used by this path. Our session
// is listed only once the fake `script` has started it; FAKE_PRIOR_SID (if set)
// is a session from an earlier turn, listed from the very beginning and ahead
// of ours -- exactly the ordering that would trap a first-match lookup.
const FAKE_CLAUDE = `
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "agents") {
  const list = [];
  if (process.env.FAKE_PRIOR_SID) {
    list.push({ kind: "interactive", cwd: process.env.FAKE_SESSION_CWD, sessionId: process.env.FAKE_PRIOR_SID, id: "short0", status: "idle" });
  }
  const started = fs.existsSync(path.join(process.env.HOME, "session-started"));
  if (started && process.env.FAKE_NO_SESSION !== "1") {
    const s = { kind: "interactive", cwd: process.env.FAKE_SESSION_CWD, sessionId: process.env.FAKE_SID, id: "short1", status: "idle" };
    if (process.env.FAKE_SESSION_STATE) s.state = process.env.FAKE_SESSION_STATE;
    list.push(s);
  }
  console.log(JSON.stringify(list));
  process.exit(0);
}
process.exit(0);
`;

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "cc-rc-bin-"));
  homeDir = await mkdtemp(join(tmpdir(), "cc-rc-home-"));
  cwd = await mkdtemp(join(tmpdir(), "cc-rc-cwd-"));
  await installFake("script", FAKE_SCRIPT);
  await installFake("claude", FAKE_CLAUDE);
});

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: homeDir,
    FAKE_SID,
    FAKE_SESSION_CWD: cwd,
    ...extra,
  };
}

describe("runClaudeTurnRemoteControlled (interactive)", () => {
  it("captures the URL from the transcript's bridgeSessionId, reads the final reply, and detects completion via turn_duration", async () => {
    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env(),
      settings: {},
      runId: "run-1",
      pollIntervalMs: 20,
      maxWaitMs: 5000,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result).toEqual({
      finalMessage: "DONE",
      failed: false,
      failureDetail: null,
      authError: false,
      sessionId: FAKE_SID,
    });
    // URL derived from bridgeSessionId "cse_TESTBRIDGE" -> session_TESTBRIDGE.
    expect(progress).toContainEqual({ message: "https://claude.ai/code/session_TESTBRIDGE", stage: "remote-control-url" });
  });

  // Regression for issue #149. A feature-sized coding turn ran correctly for
  // half an hour and was then killed by an ABSOLUTE 30-minute cap and reported
  // to the user as "Timed out after 1800000ms waiting for the remote-control
  // session to finish" -- the run had never once been idle. Every other bound
  // in the system measures silence rather than duration for exactly this
  // reason. Here the turn runs many times longer than the idle window while
  // narrating throughout, and must survive: no `maxWaitMs` is passed, because
  // there is no absolute cap any more.
  it("does not kill a turn that runs far longer than the idle window while it is still working", async () => {
    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "streaming", FAKE_STEP_MS: "30", FAKE_STEPS: "20" }),
      settings: {},
      runId: "run-long",
      pollIntervalMs: 15,
      idleTimeoutMs: 250, // far shorter than the ~600ms the turn takes
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result.failed).toBe(false);
    expect(result.failureDetail).toBeNull();
    expect(result.finalMessage).toBe("DONE");
    // ...and the caller saw the real tool-call trail, not a content-free ticker.
    expect(progress).toContainEqual({ message: "running Bash", stage: "agent" });
  });

  it("emits the URL even when the turn never completes (URL known before completion)", async () => {
    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "running" }), // transcript has bridgeSessionId but no turn_duration
      settings: {},
      runId: "run-2",
      pollIntervalMs: 20,
      idleTimeoutMs: 300,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(progress).toContainEqual({ message: "https://claude.ai/code/session_TESTBRIDGE", stage: "remote-control-url" });
    expect(result.failed).toBe(true);
  });

  // The two ways a wait ends now say which one happened. A single "Timed out
  // after 1800000ms" could not distinguish a session that worked and then
  // wedged from one whose prompt never landed, and that ambiguity is most of
  // why #149 took so long to pin down.
  it("reports a session that worked and then went silent as a stall, naming the silence", async () => {
    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "running", FAKE_ASSISTANT_TEXT: "picked up the issue" }),
      settings: {},
      runId: "run-silent",
      pollIntervalMs: 20,
      idleTimeoutMs: 300,
      heartbeatIntervalMs: 100,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result.failed).toBe(true);
    expect(result.authError).toBe(false);
    expect(result.failureDetail).toMatch(/stopped producing output/);
    expect(result.failureDetail).toMatch(/no transcript activity for \d+s/);
    expect(result.failureDetail).toMatch(/last activity: picked up the issue/);
    // The heartbeat reports the actual silence rather than asserting "still
    // running" about a session that had already stopped.
    expect(progress.some((p) => /quiet for \d+s/.test(p.message))).toBe(true);
  });

  it("reports a session that registered but never began its turn distinctly", async () => {
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "stalled" }), // bridge line only: no assistant text, no tools
      settings: {},
      runId: "run-stalled",
      pollIntervalMs: 20,
      idleTimeoutMs: 300,
    });

    expect(result.failed).toBe(true);
    expect(result.failureDetail).toMatch(/never started its turn/);
    expect(result.failureDetail).toMatch(/prompt may not have been submitted/);
  });

  it("gives up on a session that never registers, without waiting for the idle window", async () => {
    const started = Date.now();
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      // Child stays resident (no FAKE_SCRIPT_EXIT) but never registers -- a CLI
      // wedged on an unexpected first-run prompt, which never exits on its own.
      env: env({ FAKE_SCRIPT_MODE: "nofile", FAKE_NO_SESSION: "1", FAKE_SCRIPT_OUTPUT: "Is this a project you trust?" }),
      settings: {},
      runId: "run-noreg",
      pollIntervalMs: 20,
      startupTimeoutMs: 200,
      idleTimeoutMs: 60_000, // must not be what ends this wait
    });

    expect(result.failed).toBe(true);
    expect(result.failureDetail).toMatch(/never registered with the CLI/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still honours an explicit absolute cap when a caller sets one", async () => {
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "streaming", FAKE_STEP_MS: "20", FAKE_STEPS: "1000" }),
      settings: {},
      runId: "run-capped",
      pollIntervalMs: 15,
      idleTimeoutMs: 60_000, // never idle; only the absolute cap can end this
      maxWaitMs: 300,
    });

    expect(result.failed).toBe(true);
    expect(result.failureDetail).toMatch(/Timed out after 300ms/);
  });

  // `agents --json --all` lists ended sessions too, so on a second turn in the
  // same pod the previous turn's session is still there at the same cwd -- and
  // its transcript already carries a `turn_duration`. Matching it would hand
  // the previous turn's answer back as this turn's, instantly and silently.
  it("ignores a session that already existed before this run started", async () => {
    const priorSid = "99999999-8888-7777-6666-555555555555";
    const projectDir = join(homeDir, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${priorSid}.jsonl`),
      [
        JSON.stringify({ type: "summary", bridgeSessionId: "cse_STALEBRIDGE", lastSequenceNum: 0 }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "STALE" }] } }),
        JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 }),
      ].join("\n") + "\n",
    );

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_PRIOR_SID: priorSid, FAKE_ASSISTANT_TEXT: "FRESH" }),
      settings: {},
      runId: "run-second-turn",
      pollIntervalMs: 20,
      idleTimeoutMs: 5_000,
    });

    expect(result.finalMessage).toBe("FRESH");
    expect(result.sessionId).toBe(FAKE_SID);
  });

  it("reports failure (and classifies auth errors) when agents --json marks the session failed", async () => {
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "nofile", FAKE_SESSION_STATE: "failed", FAKE_SCRIPT_OUTPUT: "Invalid API key · Please run /login" }),
      settings: {},
      runId: "run-3",
      pollIntervalMs: 20,
      maxWaitMs: 5000,
    });

    expect(result.failed).toBe(true);
    expect(result.authError).toBe(true);
  });

  // Regression for AgentRun fc9f0896: an "ai-review" run whose credential had
  // expired recorded `Login expired · Please run /login` as its assistant text
  // and wrote turn_duration 11 seconds in, so the turn looked COMPLETE. The
  // auth error then travelled to the user as a turn summary ("The agent
  // produced no pushable repository or pull request. Details: ...") and nothing
  // downstream could trigger re-auth, because nothing had called it a failure.
  it("treats a completed turn whose only output is a credential complaint as an auth failure", async () => {
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_ASSISTANT_TEXT: "Login expired · Please run /login" }),
      settings: {},
      runId: "run-auth",
      pollIntervalMs: 20,
      maxWaitMs: 5000,
    });

    expect(result.failed).toBe(true);
    expect(result.authError).toBe(true);
    expect(result.finalMessage).toBeNull();
    expect(result.failureDetail).toBe("Login expired · Please run /login");
  });

  it("does not mistake a long summary that merely mentions credentials for an auth failure", async () => {
    const summary = `Reviewed the diff. ${"The auth handling looks correct; note the invalid API key branch is untested. ".repeat(4)}`;
    const result = await runClaudeTurnRemoteControlled("review the thing", {
      cwd,
      env: env({ FAKE_ASSISTANT_TEXT: summary }),
      settings: {},
      runId: "run-review",
      pollIntervalMs: 20,
      maxWaitMs: 5000,
    });

    expect(result.failed).toBe(false);
    expect(result.authError).toBe(false);
    expect(result.finalMessage).toBe(summary);
  });

  it("reports a startup failure when the session never registers and the child exits", async () => {
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "nofile", FAKE_SCRIPT_EXIT: "1", FAKE_NO_SESSION: "1", FAKE_SCRIPT_OUTPUT: "trust prompt / crash" }),
      settings: {},
      runId: "run-4",
      pollIntervalMs: 20,
      maxWaitMs: 5000,
    });

    expect(result.failed).toBe(true);
    expect(result.finalMessage).toBeNull();
  });
});
