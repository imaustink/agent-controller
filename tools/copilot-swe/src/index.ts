import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import {
  buildCopilotArgs,
  buildPrompt,
  extractProgressText,
} from "./copilot.js";
import {
  createAppJwt,
  GitHubAppError,
  mintInstallationToken,
  resolveInstallationId,
} from "./github-app.js";
import { discoverResult, ensureDir, findRepoDir, runCommand, setupGitAuth } from "./git.js";
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

/** Spawns the Copilot CLI, streaming its JSONL output into progress events. Returns the last human-readable line. */
function runCopilot(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onText: (text: string) => void,
): Promise<{ code: number; lastText: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("copilot", args, { cwd, env });
    let buffer = "";
    let lastText: string | null = null;

    const handleLine = (line: string): void => {
      const text = extractProgressText(line);
      if (text) {
        lastText = text;
        onText(text);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    // Copilot logs diagnostics to stderr; keep them out of stdout but visible in pod logs.
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(clip(chunk.toString(), 500)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      resolve({ code: code ?? 1, lastText });
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

  if (!config.githubAppId || !config.githubAppPrivateKey) {
    fail("usage", EXIT.usage, "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured");
  }
  if (!config.copilotGithubToken) {
    fail("usage", EXIT.usage, "COPILOT_GITHUB_TOKEN (a Copilot-entitled fine-grained PAT) must be configured");
  }

  // --- Authenticate: mint a short-lived GitHub App installation token. ---
  await emitter.progress("authenticate");
  let token: string;
  try {
    const jwt = createAppJwt(config.githubAppId, config.githubAppPrivateKey);
    const installationId = await resolveInstallationId(jwt, {
      apiUrl: config.githubApiUrl,
      timeoutMs: config.fetchTimeoutMs,
      configuredId: config.githubAppInstallationId,
      repo: marker?.repo,
    });
    const minted = await mintInstallationToken(jwt, installationId, {
      apiUrl: config.githubApiUrl,
      timeoutMs: config.fetchTimeoutMs,
    });
    token = minted.token;
  } catch (err) {
    if (err instanceof GitHubAppError) {
      fail("auth", EXIT.auth, `GitHub App authentication failed: ${err.message}`);
    }
    fail("auth", EXIT.auth, `GitHub App authentication failed: ${(err as Error).message}`);
  }

  // --- Prepare the workspace and credentials. ---
  await emitter.progress("prepare");
  await ensureDir(config.homeDir);
  await ensureDir(config.workdir);
  const apiHost = new URL(config.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(config.githubApiUrl).host;
  await setupGitAuth({ homeDir: config.homeDir, token, appId: config.githubAppId, apiHost });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: config.homeDir,
    COPILOT_HOME: `${config.homeDir}/.copilot`,
    // Model auth for Copilot uses the Copilot-entitled PAT; all git/gh
    // operations use the App installation token via GH_TOKEN. Keeping these
    // two separate is the whole point (see docs/security.md).
    COPILOT_GITHUB_TOKEN: config.copilotGithubToken,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    COPILOT_AUTO_UPDATE: "false",
  };

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
    fail("agent", EXIT.agent, `The coding agent exited with code ${result.code}`);
  }

  // --- Finalize: discover the repo/branch/PR the agent produced. ---
  await emitter.progress("finalize");
  const repoDir = await findRepoDir(config.workdir);
  if (!repoDir) {
    fail("git", EXIT.git, "The agent finished but produced no git repository to report on");
  }
  const discovered = await discoverResult(repoDir, childEnv);
  if (!discovered || !discovered.repo || !discovered.branch) {
    fail("git", EXIT.git, "Could not determine the repository/branch the agent worked on");
  }

  const nextMarker: SweMarker = {
    repo: discovered.repo,
    branch: discovered.branch,
    pr: discovered.pr,
    session: marker?.session ?? randomUUID(),
  };

  const summary = result.lastText ? clip(result.lastText, 1500) : "The coding agent completed the task.";
  const prLine = discovered.prUrl
    ? `\n\n---\n✅ ${marker?.pr ? "Updated" : "Opened"} pull request: [${discovered.repo}#${discovered.pr}](${discovered.prUrl})`
    : `\n\n---\n⚠️ Work pushed to \`${discovered.repo}\` branch \`${discovered.branch}\`, but no open pull request was found.`;

  await emitter.succeeded(`${renderSweMarker(nextMarker)}${summary}${prLine}`);
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
