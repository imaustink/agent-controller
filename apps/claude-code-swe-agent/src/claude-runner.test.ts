import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeTurn } from "./claude-runner.js";

/**
 * Stands in for the real `claude` CLI: a fake executable script on PATH that
 * prints canned `--output-format stream-json` NDJSON, shaped like Claude
 * Code CLI v2.1.218's documented headless-mode output. Avoids spawning the
 * real CLI (which needs a real credential and hits the real API) while still
 * exercising `claude-runner.ts`'s actual `spawn` + NDJSON-parsing code, same
 * "real subprocess, fake binary" style as git.test.ts.
 */
let binDir: string;

async function installFakeClaude(script: string): Promise<void> {
  const path = join(binDir, "claude");
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "claude-runner-test-bin-"));
});

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

describe("runClaudeTurn", () => {
  it("captures the session id, narrates progress, and extracts the final result on success", async () => {
    await installFakeClaude(`
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_abc123" }));
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the repo" }] } }));
      console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } }));
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "sess_abc123", result: "Opened PR #7" }));
    `);

    const progress: Array<{ message: string; stage: string }> = [];
    const result = await runClaudeTurn("do the thing", {
      cwd: process.cwd(),
      env: env(),
      settings: {},
      onProgress: (message, stage) => progress.push({ message, stage }),
    });

    expect(result).toEqual({
      finalMessage: "Opened PR #7",
      failed: false,
      failureDetail: null,
      authError: false,
      sessionId: "sess_abc123",
    });
    expect(progress).toEqual([
      { message: "Looking at the repo", stage: "agent-text" },
      { message: "running Bash", stage: "agent" },
    ]);
  });

  it("reports a failed turn via result.is_error", async () => {
    await installFakeClaude(`
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" }));
      console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "something went wrong" }));
    `);

    const result = await runClaudeTurn("do the thing", { cwd: process.cwd(), env: env(), settings: {} });
    expect(result.failed).toBe(true);
    expect(result.failureDetail).toBe("something went wrong");
    expect(result.authError).toBe(false);
  });

  it("classifies an expired/invalid credential as an auth error", async () => {
    await installFakeClaude(`
      console.error("Invalid API key · Please run /login");
      process.exit(1);
    `);

    const result = await runClaudeTurn("do the thing", { cwd: process.cwd(), env: env(), settings: {} });
    expect(result.failed).toBe(true);
    expect(result.authError).toBe(true);
  });

  it("treats a non-zero exit with no JSON output at all as a failure", async () => {
    await installFakeClaude(`
      console.error("boom");
      process.exit(1);
    `);

    const result = await runClaudeTurn("do the thing", { cwd: process.cwd(), env: env(), settings: {} });
    expect(result.failed).toBe(true);
    expect(result.failureDetail).toContain("boom");
  });
});
