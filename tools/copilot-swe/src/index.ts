import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import {
  buildCopilotArgs,
  buildPrompt,
  parseCopilotLine,
} from "./copilot.js";
import { discoverResult, ensureDir, findRepoDir, resolveGitIdentity, runCommand, setupGitAuth } from "./git.js";
import { parseSweMarker, renderSweMarker, type SweMarker } from "./marker.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { InstructionSchema, type SweErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  auth: 3,
  agent: 4,
  git: 5,
  general: 1,
} as const;

class PipelineError extends Error {
  constructor(
    readonly code: SweErrorCode,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: SweErrorCode, exitCode: number, message: string): never {
  throw new PipelineError(code, exitCode, clip(message, 2000));
}

/** Spawns the Copilot CLI, streaming its JSONL output into progress events. Returns the final assistant message, any tool failures, and a bounded transcript. */
function runCopilot(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onProgress: (text: string) => void,
): Promise<{ code: number; finalMessage: string | null; toolFailures: string[]; transcript: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("copilot", args, { cwd, env });
    let buffer = "";
    let finalMessage: string | null = null;
    const toolFailures: string[] = [];
    const parts: string[] = [];
    let transcriptLen = 0;
    let rawOut = "";

    const handleLine = (line: string): void => {
      const sig = parseCopilotLine(line);
      if (!sig) return;
      if (sig.finalMessage) finalMessage = sig.finalMessage;
      if (sig.toolFailure) toolFailures.push(sig.toolFailure);
      if (sig.progress) {
        onProgress(sig.progress);
        if (transcriptLen < 8000) {
          parts.push(sig.progress);
          transcriptLen += sig.progress.length + 1;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      if (rawOut.length < 20000) rawOut += s;
      buffer += s;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    // Copilot logs diagnostics to stderr; keep them out of stdout but visible in pod logs.
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(clip(chunk.toString(), 2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      // Echo the agent's raw stdout to pod logs for debuggability (bounded + redacted).
      process.stderr.write(`--- copilot raw stdout (exit ${code}) ---\n${clip(rawOut, 20000)}\n--- end raw ---\n`);
      resolve({ code: code ?? 1, finalMessage, toolFailures, transcript: parts.join("\n") });
    });
  });
}

async function run(emitter: JobEmitter, rawInput: string): Promise<void> {
  const parsed = InstructionSchema.safeParse(rawInput);
  if (!parsed.success) {
    fail("usage", EXIT.usage, "Instruction must not be empty");
  }

  const { marker, instruction } = parseSweMarker(parsed.data);
  if (!instruction.trim()) {
    fail("usage", EXIT.usage, "Instruction must not be empty after removing the marker");
  }

  if (!config.githubToken) {
    fail(
      "usage",
      EXIT.usage,
      "GITHUB_TOKEN (a fine-grained PAT with Copilot Requests + Contents/Pull requests write) must be configured",
    );
  }

  const token = config.githubToken;

  // --- Authenticate & prepare credentials. ---
  // One PAT authenticates BOTH the Copilot model (COPILOT_GITHUB_TOKEN) and
  // all git/gh operations (GH_TOKEN) — see docs/security.md.
  await emitter.progress("authenticate");
  await ensureDir(config.homeDir);
  await ensureDir(config.workdir);
  const apiHost = new URL(config.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(config.githubApiUrl).host;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: config.homeDir,
    COPILOT_HOME: `${config.homeDir}/.copilot`,
    COPILOT_GITHUB_TOKEN: token,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    COPILOT_AUTO_UPDATE: "false",
  };

  const identity = (await resolveGitIdentity(childEnv)) ?? {
    name: "copilot-swe",
    email: "copilot-swe@users.noreply.github.com",
  };
  await setupGitAuth({ homeDir: config.homeDir, token, apiHost, identity });

  // --- Prepare the workspace. ---
  await emitter.progress("prepare");

  // On a continuation turn, pre-clone the known repo so Copilot resumes in the
  // right place. Best-effort: if it fails, Copilot is instructed to clone itself.
  if (marker?.repo) {
    const dest = `${config.workdir}/${marker.repo.split("/")[1]}`;
    const clone = await runCommand("git", ["clone", `https://${apiHost}/${marker.repo}.git`, dest], { env: childEnv });
    if (clone.code === 0 && marker.branch) {
      await runCommand("git", ["-C", dest, "checkout", marker.branch], { env: childEnv });
    }
  }

  // --- Run the coding agent. ---
  await emitter.progress("agent");
  const prompt = buildPrompt(instruction, marker);
  const args = buildCopilotArgs({ prompt, workdir: config.workdir, model: config.copilotModel });

  let lastThrottle = 0;
  const result = await runCopilot(args, childEnv, config.workdir, (text) => {
    const now = Date.now();
    if (now - lastThrottle > 2000) {
      lastThrottle = now;
      void emitter.progress("agent", { message: clip(text, 200) });
    }
  });
  if (result.code !== 0) {
    const detail = result.toolFailures.length ? `: ${clip(result.toolFailures[result.toolFailures.length - 1]!, 800)}` : "";
    fail("agent", EXIT.agent, `The coding agent exited with code ${result.code}${detail}`);
  }

  // --- Finalize: discover the repo/branch/PR the agent produced. ---
  await emitter.progress("finalize");

  const summary = clip(result.finalMessage || result.transcript || "The coding agent finished without a summary.", 4000);

  const repoDir = await findRepoDir(config.workdir);
  const discovered = repoDir ? await discoverResult(repoDir, childEnv) : null;
  if (!discovered || !discovered.repo || !discovered.branch) {
    // No verifiable repository/branch was produced. Treat as a FAILURE and
    // surface the real cause (a failed tool command, e.g. a permission error)
    // rather than the agent's own — possibly hallucinated — success summary.
    const cause = result.toolFailures.length
      ? clip(result.toolFailures[result.toolFailures.length - 1]!, 1200)
      : clip(summary, 1200);
    fail("git", EXIT.git, `The agent produced no pushable repository or pull request. Details: ${cause}`);
  }

  const nextMarker: SweMarker = {
    repo: discovered.repo,
    branch: discovered.branch,
    pr: discovered.pr,
    session: marker?.session ?? randomUUID(),
  };

  const prLine = discovered.prUrl
    ? `\n\n---\n✅ ${marker?.pr ? "Updated" : "Opened"} pull request: [${discovered.repo}#${discovered.pr}](${discovered.prUrl})`
    : `\n\n---\n⚠️ Work is on \`${discovered.repo}\` branch \`${discovered.branch}\`, but no open pull request was found.`;

  await emitter.succeeded(`${renderSweMarker(nextMarker)}${clip(summary, 1500)}${prLine}`);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawInput = process.argv[2];

  try {
    if (!rawInput) {
      fail("usage", EXIT.usage, "Usage: copilot-swe '<software-engineering instruction>'");
    }
    await emitter.accepted(clip(rawInput, 200));
    await run(emitter, rawInput);
    await emitter.close();
  } catch (err) {
    const { code, exitCode, message } = toPipelineError(err);
    process.stderr.write(`${message}\n`);
    try {
      await emitter.failed(code, message);
      await emitter.close();
    } catch {
      // Event stream is best-effort on the failure path; the exit code is the backstop.
    }
    process.exit(exitCode);
  }
}

function toPipelineError(err: unknown): { code: SweErrorCode; exitCode: number; message: string } {
  if (err instanceof PipelineError) {
    return { code: err.code, exitCode: err.exitCode, message: err.message };
  }
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
