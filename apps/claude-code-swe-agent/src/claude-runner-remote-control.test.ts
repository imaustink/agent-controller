import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const FAKE_SCRIPT = `
const fs = require("fs"), path = require("path");
const HOME = process.env.HOME, SID = process.env.FAKE_SID;
// Use the exact cwd string the runner uses (FAKE_SESSION_CWD === opts.cwd), NOT
// process.cwd() -- on macOS the latter resolves /var -> /private/var and the
// path hash would then differ from what the runner reads (a test-only quirk;
// Linux/production has no such symlink).
const dir = path.join(HOME, ".claude", "projects", process.env.FAKE_SESSION_CWD.replace(/[/.]/g, "-"));
const mode = process.env.FAKE_SCRIPT_MODE || "complete";
if (process.env.FAKE_SCRIPT_OUTPUT) process.stdout.write(process.env.FAKE_SCRIPT_OUTPUT);
if (mode !== "nofile") {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "summary", bridgeSessionId: "cse_TESTBRIDGE", lastSequenceNum: 0 })];
  if (mode !== "running") lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } }));
  if (mode === "complete") lines.push(JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 }));
  fs.writeFileSync(path.join(dir, SID + ".jsonl"), lines.join("\\n") + "\\n");
}
if (process.env.FAKE_SCRIPT_EXIT === "1") process.exit(0);
setInterval(() => {}, 1e9);
`;

// Fake `claude`: only `agents --json --all` is used by this path.
const FAKE_CLAUDE = `
const args = process.argv.slice(2);
if (args[0] === "agents") {
  if (process.env.FAKE_NO_SESSION === "1") { console.log("[]"); process.exit(0); }
  const s = { kind: "interactive", cwd: process.env.FAKE_SESSION_CWD, sessionId: process.env.FAKE_SID, id: "short1", status: "idle" };
  if (process.env.FAKE_SESSION_STATE) s.state = process.env.FAKE_SESSION_STATE;
  console.log(JSON.stringify([s]));
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

  it("emits the URL even when the turn never completes (URL known before completion)", async () => {
    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd,
      env: env({ FAKE_SCRIPT_MODE: "running" }), // transcript has bridgeSessionId but no turn_duration
      settings: {},
      runId: "run-2",
      pollIntervalMs: 20,
      maxWaitMs: 300,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(progress).toContainEqual({ message: "https://claude.ai/code/session_TESTBRIDGE", stage: "remote-control-url" });
    expect(result.failed).toBe(true);
    expect(result.failureDetail).toMatch(/Timed out/);
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
