import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeTurnRemoteControlled } from "./claude-runner.js";

/**
 * Stands in for the real `claude` CLI's Remote Control path. Unlike
 * claude-runner.test.ts's fake (which mimics the confirmed `-p ...
 * --output-format stream-json` shape), everything this fake produces for
 * `--bg --remote-control` and `claude agents --json` is a guess -- see the
 * "Remote Control path" doc-comment block in claude-runner.ts. The fake
 * dispatches on `process.argv` so one script can behave differently for the
 * initial handoff spawn vs. the repeated `agents --json` poll spawn.
 */
let binDir: string;

async function installFakeClaude(script: string): Promise<void> {
  const path = join(binDir, "claude");
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "claude-runner-rc-test-bin-"));
});

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

describe("runClaudeTurnRemoteControlled", () => {
  it("polls `agents --json --all` (a terminated session is invisible without --all) -- regression for the real hang", async () => {
    // Confirmed empirically against the real logged-in CLI: plain
    // `claude agents --json` returns [] the instant a session terminates;
    // only `--all` includes done/failed sessions. This fake reproduces that
    // exactly -- it returns the finished entry ONLY when --all is present,
    // and [] otherwise. Under the pre-fix code (no --all) this would hang to
    // the maxWait timeout; the test asserts it completes promptly instead.
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        const all = args.includes("--all");
        console.log(JSON.stringify(all ? [
          { name: "do the thing", id: "term1", status: "idle", state: "done" },
        ] : []));
        process.exit(0);
      } else {
        console.log("Starting background service…\\nbackgrounded · term1");
        process.exit(0);
      }
    `);

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-all",
      pollIntervalMs: 5,
      maxWaitMs: 2000,
    });

    // Found via --all and reported terminal (state: done) -- NOT a timeout.
    expect(result.failed).toBe(false);
    expect(result.sessionId).toBe("term1");
    expect(result.failureDetail).toBeNull();
  });

  it("scrapes the Remote Control URL from the initial --bg handoff's stdout", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        // Session is already finished by the time anything polls.
        console.log(JSON.stringify([
          { name: "swe-run-1", id: "sess_1", status: "completed", result: "Opened PR #9" },
        ]));
        process.exit(0);
      } else {
        console.log("Remote Control session ready: https://claude.ai/code/session_abc123");
        process.exit(0);
      }
    `);

    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-1",
      pollIntervalMs: 5,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result).toEqual({
      finalMessage: "Opened PR #9",
      failed: false,
      failureDetail: null,
      authError: false,
      sessionId: "sess_1",
    });
    expect(progress).toEqual([{ message: "https://claude.ai/code/session_abc123", stage: "remote-control-url" }]);
  });

  it("discovers the URL and completion via polled `claude agents --json` when the initial spawn prints nothing", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        const attempt = Number(process.env.RC_POLL_ATTEMPT || "0");
        const fs = require("fs");
        const stateFile = process.env.RC_STATE_FILE;
        let count = 0;
        try { count = Number(fs.readFileSync(stateFile, "utf8")); } catch {}
        count += 1;
        fs.writeFileSync(stateFile, String(count));
        if (count === 1) {
          console.log(JSON.stringify([{ name: "swe-run-2", id: "sess_2", status: "running", url: "https://claude.ai/code/session_def456" }]));
        } else {
          console.log(JSON.stringify([{ name: "swe-run-2", id: "sess_2", status: "completed", result: "Updated PR #3" }]));
        }
        process.exit(0);
      } else {
        // Nothing printed on handoff -- exercises the "URL only known via polling" path.
        process.exit(0);
      }
    `);

    const stateFile = join(binDir, "poll-count");
    await writeFile(stateFile, "0");

    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: { ...env(), RC_STATE_FILE: stateFile },
      settings: {},
      runId: "run-2",
      pollIntervalMs: 5,
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result).toEqual({
      finalMessage: "Updated PR #3",
      failed: false,
      failureDetail: null,
      authError: false,
      sessionId: "sess_2",
    });
    expect(progress).toEqual([{ message: "https://claude.ai/code/session_def456", stage: "remote-control-url" }]);
  });

  it("treats malformed/unexpected `claude agents --json` output as still-in-progress rather than crashing", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        const fs = require("fs");
        const stateFile = process.env.RC_STATE_FILE;
        let count = 0;
        try { count = Number(fs.readFileSync(stateFile, "utf8")); } catch {}
        count += 1;
        fs.writeFileSync(stateFile, String(count));
        if (count === 1) {
          console.log("not json at all");
        } else if (count === 2) {
          console.log(JSON.stringify({ unexpected: "shape", nested: { deeply: true } }));
        } else if (count === 3) {
          // An array, but entries missing every field this code looks for.
          console.log(JSON.stringify([{ totallyDifferent: true }, 42, null]));
        } else {
          console.log(JSON.stringify([{ name: "swe-run-3", id: "sess_3", status: "completed", result: "done" }]));
        }
        process.exit(0);
      } else {
        process.exit(0);
      }
    `);

    const stateFile = join(binDir, "poll-count-2");
    await writeFile(stateFile, "0");

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: { ...env(), RC_STATE_FILE: stateFile },
      settings: {},
      runId: "run-3",
      pollIntervalMs: 5,
    });

    expect(result.failed).toBe(false);
    expect(result.finalMessage).toBe("done");
    expect(result.sessionId).toBe("sess_3");
  });

  it("classifies an auth failure on the initial --bg handoff the same way as the one-shot path", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        console.log(JSON.stringify([]));
        process.exit(0);
      } else {
        console.error("Invalid API key · Please run /login");
        process.exit(1);
      }
    `);

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-4",
      pollIntervalMs: 5,
    });

    expect(result.failed).toBe(true);
    expect(result.authError).toBe(true);
  });

  it("classifies a failed status reported via `claude agents --json` as a failure", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        console.log(JSON.stringify([{ name: "swe-run-5", id: "sess_5", status: "failed", result: "oauth token has expired" }]));
        process.exit(0);
      } else {
        process.exit(0);
      }
    `);

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-5",
      pollIntervalMs: 5,
    });

    expect(result.failed).toBe(true);
    expect(result.authError).toBe(true);
    expect(result.failureDetail).toBe("oauth token has expired");
  });

  it("matches the session by the short id scraped from 'backgrounded · <id>', NOT by name -- regression for a real hang", async () => {
    // Confirmed empirically against the real CLI: `claude agents --json`'s
    // `name` field is the PROMPT TEXT, not the `--remote-control <name>`
    // value this code passes -- so `name` never matches `sessionName`,
    // ever. This is exactly what caused every real Remote Control triage
    // run to hang until the Job timeout: the poll loop could never find its
    // own session. The real fix matches on `id`, scraped from the initial
    // handoff's "backgrounded · <id>" line.
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        console.log(JSON.stringify([
          // "name" is the prompt text (as the real CLI actually returns),
          // completely unrelated to sessionName ("swe-run-7") -- only "id"
          // (matching the scraped short id below) should be used to find it.
          { name: "do the thing", id: "ab12cd34", status: "completed", result: "Opened PR #11" },
        ]));
        process.exit(0);
      } else {
        console.log("Starting background service…\\nbackgrounded · ab12cd34");
        process.exit(0);
      }
    `);

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-7",
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      finalMessage: "Opened PR #11",
      failed: false,
      failureDetail: null,
      authError: false,
      sessionId: "ab12cd34",
    });
  });

  it("detects completion via 'state: done' (status stays 'idle') and reads the final message from the session's own JSONL transcript -- regression for a real hang after a real task finished", async () => {
    // Confirmed empirically against the real CLI: a finished background
    // session reports `status: "idle"` (checking only `status`, an earlier
    // version of this code, never sees a terminal value there) alongside
    // the REAL lifecycle signal in a separate `state: "done"` field -- and
    // there is no result/output/message field at all, ever, for a finished
    // session. This is exactly what caused a real triage run to open a PR
    // successfully and then hang anyway: this code never noticed it had
    // finished. The fix checks both `status` and `state`, and falls back to
    // reading the session's own JSONL transcript for the final reply text.
    const homeDir = await mkdtemp(join(tmpdir(), "claude-runner-rc-test-home-"));
    const cwd = process.cwd();
    const longSessionId = "4ebeef3c-aca9-4f63-84b4-a503a95bbb12";
    const projectDirName = cwd.replace(/[/.]/g, "-");
    const transcriptDir = join(homeDir, ".claude", "projects", projectDirName);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, `${longSessionId}.jsonl`),
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: longSessionId }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Opened PR #131" }] },
        }),
        JSON.stringify({ type: "system", subtype: "turn_duration" }),
      ].join("\n") + "\n",
    );

    try {
      await installFakeClaude(`
        const args = process.argv.slice(2);
        if (args[0] === "agents") {
          console.log(JSON.stringify([
            { name: "autonomous coding agent", id: "4ebeef3c", sessionId: "${longSessionId}", status: "idle", state: "done" },
          ]));
          process.exit(0);
        } else {
          console.log("Starting background service…\\nbackgrounded · 4ebeef3c");
          process.exit(0);
        }
      `);

      const result = await runClaudeTurnRemoteControlled("create test.md", {
        cwd,
        env: { ...env(), HOME: homeDir },
        settings: {},
        runId: "run-8",
        pollIntervalMs: 5,
      });

      expect(result).toEqual({
        finalMessage: "Opened PR #131",
        failed: false,
        failureDetail: null,
        authError: false,
        sessionId: "4ebeef3c",
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("times out and reports failure if the session never reports completion", async () => {
    await installFakeClaude(`
      const args = process.argv.slice(2);
      if (args[0] === "agents") {
        console.log(JSON.stringify([{ name: "swe-run-6", id: "sess_6", status: "running" }]));
        process.exit(0);
      } else {
        process.exit(0);
      }
    `);

    const result = await runClaudeTurnRemoteControlled("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      runId: "run-6",
      pollIntervalMs: 5,
      maxWaitMs: 30,
    });

    expect(result.failed).toBe(true);
    expect(result.failureDetail).toMatch(/Timed out/);
  });
});
