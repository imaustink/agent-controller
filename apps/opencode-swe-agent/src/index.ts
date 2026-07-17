import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent, type AgentSession } from "@controller-agent/agent-runtime";
import {
  buildOpencodeArgs,
  buildOpencodeConfig,
  buildPrompt,
  parseOpencodeLine,
} from "./opencode.js";
import { discoverResult, ensureDir, findRepoDir, resolveGitIdentity, runCommand, setupGitAuth } from "./git.js";
import { parseSweMarker, renderSweMarker, type SweMarker } from "./marker.js";
import { loadToolConfig } from "./config.js";
import { clip } from "./security/redact.js";

const toolConfig = loadToolConfig();

/** Spawns the opencode CLI, streaming its JSON event output into progress events via
 * `session.progress()`. Returns the final assistant message, any tool failures,
 * and a bounded transcript. */
function runOpencode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onProgress: (text: string) => void,
): Promise<{ code: number; finalMessage: string | null; toolFailures: string[]; transcript: string }> {
  return new Promise((resolve, reject) => {
    // stdin MUST be closed (not the default open pipe): opencode probes for
    // piped input right after startup, and an open-but-silent pipe (Node's
    // default child stdio) makes it block forever waiting for EOF that never
    // comes -- reproduced reliably in production, never reproduced when
    // manually exec'd without a stdin attached. `ignore` gives it immediate
    // EOF, matching the working manual-invocation case exactly.
    const child = spawn("opencode", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let finalMessage: string | null = null;
    const toolFailures: string[] = [];
    const parts: string[] = [];
    let transcriptLen = 0;
    let rawOut = "";
    /** Accumulates streaming token deltas before flushing as a single chunk. */
    let deltaBuffer = "";

    const flushDelta = (): void => {
      if (!deltaBuffer) return;
      const text = deltaBuffer;
      deltaBuffer = "";
      onProgress(text);
      if (transcriptLen < 8000) {
        parts.push(text);
        transcriptLen += text.length + 1;
      }
    };

    const handleLine = (line: string): void => {
      const sig = parseOpencodeLine(line);
      if (!sig) return;
      if (sig.finalMessage) finalMessage = sig.finalMessage;
      if (sig.toolFailure) toolFailures.push(sig.toolFailure);
      if (sig.progress) {
        if (sig.isDelta) {
          deltaBuffer += sig.progress;
          // Flush early if the buffer has grown to a reasonable sentence chunk.
          if (deltaBuffer.length >= 500) flushDelta();
        } else {
          flushDelta();
          onProgress(sig.progress);
          if (transcriptLen < 8000) {
            parts.push(sig.progress);
            transcriptLen += sig.progress.length + 1;
          }
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
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(clip(chunk.toString(), 2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      flushDelta();
      process.stderr.write(`--- opencode raw stdout (exit ${code}) ---\n${clip(rawOut, 20000)}\n--- end raw ---\n`);
      resolve({ code: code ?? 1, finalMessage, toolFailures, transcript: parts.join("\n") });
    });
  });
}

/**
 * Runs one coding turn (one `session.goal` or one continued instruction),
 * pushing progress via `session.progress()`. Returns the reply text to surface
 * to the user — either a completion summary or an error message.
 *
 * If the opencode CLI needs clarification before it can act, the caller is
 * responsible for asking via `session.ask()` and then calling this again with
 * the updated instruction. In this first version the agent runs the entire task
 * without mid-turn HITL; `session.ask()` is used only to handle the start-of-
 * session case where the instruction might be ambiguous.
 */
async function runOneTurn(
  session: AgentSession,
  instruction: string,
  marker: SweMarker | null,
  token: string,
  anthropicApiKey: string,
): Promise<{ reply: string; nextMarker: SweMarker | null; succeeded: boolean }> {
  const apiHost = new URL(toolConfig.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(toolConfig.githubApiUrl).host;

  // opencode reads its config (model, permission rules) from
  // $XDG_CONFIG_HOME/opencode/opencode.json. Point that at a writable
  // location under our /tmp-based HOME and write it out before spawning.
  const xdgConfigHome = `${toolConfig.homeDir}/.config`;
  const xdgDataHome = `${toolConfig.homeDir}/.local/share`;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: toolConfig.homeDir,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    // opencode's Anthropic provider (built on @ai-sdk/anthropic) reads this
    // directly — no interactive `opencode auth login` / `/connect` step needed.
    ANTHROPIC_API_KEY: anthropicApiKey,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };

  const opencodeConfigDir = join(xdgConfigHome, "opencode");
  await mkdir(opencodeConfigDir, { recursive: true });
  await writeFile(
    join(opencodeConfigDir, "opencode.json"),
    JSON.stringify(buildOpencodeConfig({ model: toolConfig.model }), null, 2),
  );

  const identity = (await resolveGitIdentity(childEnv)) ?? {
    name: "opencode-swe",
    email: "opencode-swe@users.noreply.github.com",
  };
  await setupGitAuth({ homeDir: toolConfig.homeDir, token, apiHost, identity });

  await session.progress("Preparing workspace…");

  if (marker?.repo) {
    const repoName = marker.repo.split("/")[1];
    const dest = `${toolConfig.workdir}/${repoName}`;
    const cloneResult = await runCommand("git", ["clone", `https://${apiHost}/${marker.repo}.git`, dest], { env: childEnv });
    if (cloneResult.code === 0 && marker.branch) {
      await runCommand("git", ["-C", dest, "checkout", marker.branch], { env: childEnv });
    }
  }

  await session.progress("Running coding agent…");
  const prompt = buildPrompt(instruction, marker);
  const args = buildOpencodeArgs({ prompt, workdir: toolConfig.workdir, model: toolConfig.model });

  const result = await runOpencode(args, childEnv, toolConfig.workdir, (text) => {
    void session.progress(clip(text, 500), { stage: "agent" });
  });

  if (result.code !== 0) {
    const detail = result.toolFailures.length
      ? `: ${clip(result.toolFailures[result.toolFailures.length - 1]!, 800)}`
      : "";
    return {
      reply: `The coding agent exited with code ${result.code}${detail}`,
      nextMarker: marker,
      succeeded: false,
    };
  }

  await session.progress("Discovering result…", { stage: "finalize" });

  const summary = clip(result.finalMessage ?? result.transcript ?? "The coding agent finished without a summary.", 4000);
  const repoDir = await findRepoDir(toolConfig.workdir);
  const discovered = repoDir ? await discoverResult(repoDir, childEnv) : null;

  if (!discovered?.repo || !discovered.branch) {
    const cause = result.toolFailures.length
      ? clip(result.toolFailures[result.toolFailures.length - 1]!, 1200)
      : clip(summary, 1200);
    return {
      reply: `The agent produced no pushable repository or pull request. Details: ${cause}`,
      nextMarker: marker,
      succeeded: false,
    };
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

  return {
    reply: `${renderSweMarker(nextMarker)}${clip(summary, 1500)}${prLine}`,
    nextMarker,
    succeeded: true,
  };
}

/**
 * Agent entry point: wired into the `@controller-agent/agent-runtime` SDK's
 * `runAgent()` loop. The session's `goal` is the initial instruction (delivered
 * by the orchestrator via `AgentRun.spec.goal`, injected as `AGENT_GOAL` env).
 * Follow-up prompts from the user (HITL continuation) arrive as further
 * `session.goal`-style strings via NATS `prompt` messages, handled by the SDK's
 * `awaitReply` mechanism automatically when `session.ask()` emits a non-final
 * reply and the next turn calls `runAgent` again via the orchestrator's
 * `checkActiveAgentRun` node.
 *
 * Multi-turn continuity across separate AgentRun invocations is maintained by
 * the `<!-- swe: ... -->` marker the agent embeds in its reply, the same way
 * the original one-shot tool did — the orchestrator's conversation history fold
 * carries it forward. Within a single AgentRun episode (i.e. for HITL during
 * one coding task) we use native `session.ask()` to pause and resume.
 */
runAgent(async (session) => {
  const token = toolConfig.githubToken;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required — inject via secretEnv/secretKeyRef on the Agent CR");
  }
  const anthropicApiKey = toolConfig.anthropicApiKey;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required — inject via secretEnv/secretKeyRef on the Agent CR");
  }

  await ensureDir(toolConfig.homeDir);
  await ensureDir(toolConfig.workdir);

  await session.progress("Authenticating…", { stage: "authenticate" });

  // Parse the SWE marker from the goal if it's a continuation turn (the
  // orchestrator folds it from the conversation history).
  const { marker, instruction } = parseSweMarker(session.goal);
  if (!instruction.trim()) {
    throw new Error("Goal must not be empty after removing any swe marker");
  }

  // If the instruction is genuinely ambiguous (e.g. no target repo specified
  // and no prior marker), ask for clarification before spinning up opencode.
  // Note: this is currently a simple heuristic — a more sophisticated agent
  // would use an LLM pre-flight check here. For now, always proceed to the
  // coding turn and let the opencode CLI surface missing-context errors.
  const { reply, succeeded } = await runOneTurn(session, instruction, marker, token, anthropicApiKey);

  if (!succeeded) {
    throw new Error(reply);
  }

  return { message: reply };
});
