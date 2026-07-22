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
import { appendCoAuthorTrailer, discoverResult, ensureDir, findRepoDir, resolveGitIdentity, runCommand, setupGitAuth } from "./git.js";
import { extractContinuationToken } from "./continuation.js";
import { decodeSweContinuation, encodeSweContinuation, type SweMarker } from "./marker.js";
import { loadToolConfig } from "./config.js";
import { resolveGithubToken } from "@controller-agent/github-app-auth";
import { AuthorizationError, finalizeDelegatedWrite, isDelegating, resolveDelegatedToken } from "./identityDelegation.js";
import { clip } from "./security/redact.js";

const toolConfig = loadToolConfig();

/** Spawns the opencode CLI, streaming its JSON event output into progress events via
 * `session.progress()`. Returns the final assistant message, any tool failures,
 * and a bounded transcript. */
function runOpencode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onProgress: (text: string, kind: "narrative" | "status") => void,
  signal?: AbortSignal,
): Promise<{ code: number; finalMessage: string | null; toolFailures: string[]; transcript: string }> {
  return new Promise((resolve, reject) => {
    // stdin MUST be closed (not the default open pipe): opencode probes for
    // piped input right after startup, and an open-but-silent pipe (Node's
    // default child stdio) makes it block forever waiting for EOF that never
    // comes -- reproduced reliably in production, never reproduced when
    // manually exec'd without a stdin attached. `ignore` gives it immediate
    // EOF, matching the working manual-invocation case exactly.
    // `signal` lets a `cancel` from the orchestrator kill this subprocess
    // directly -- without it, cancelling only rejects a pending ask() and the
    // coding agent keeps running (and streaming progress) to completion.
    const child = spawn("opencode", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal });
    let buffer = "";
    let finalMessage: string | null = null;
    const toolFailures: string[] = [];
    const parts: string[] = [];
    let transcriptLen = 0;
    /** Accumulates streaming token deltas before flushing as a single chunk. */
    let deltaBuffer = "";
    // Whether the in-flight delta buffer is a continuation of the same
    // narrative unit as the last emission (no separator needed) versus the
    // start of a fresh one (opencode emits a burst of deltas per message/tool
    // cycle, back-to-back with no whitespace of its own between cycles).
    let deltaBufferOpen = false;
    let pendingPrefix = "";
    let anyNarrativeEmitted = false;

    // Deltas only ever come from narrative signals (text-delta/reasoning-delta,
    // see opencode.ts) — the buffer never mixes in mechanical tool-call text.
    const flushDelta = (): void => {
      if (!deltaBuffer) return;
      const raw = deltaBuffer;
      deltaBuffer = "";
      const text = pendingPrefix ? `${pendingPrefix}${raw}` : raw;
      pendingPrefix = "";
      anyNarrativeEmitted = true;
      onProgress(text, "narrative");
      if (transcriptLen < 8000) {
        parts.push(raw);
        transcriptLen += raw.length + 1;
      }
    };

    const handleLine = (line: string): void => {
      const sig = parseOpencodeLine(line);
      if (!sig) return;
      if (sig.finalMessage) finalMessage = sig.finalMessage;
      if (sig.toolFailure) toolFailures.push(sig.toolFailure);

      if (sig.progress && sig.isDelta) {
        // Continuation of the same in-flight message -- no unit boundary.
        if (!deltaBufferOpen && anyNarrativeEmitted) pendingPrefix = "\n\n";
        deltaBufferOpen = true;
        deltaBuffer += sig.progress;
        // Flush early if the buffer has grown to a reasonable sentence chunk.
        if (deltaBuffer.length >= 500) flushDelta();
        return;
      }

      // Anything else (a whole message, a tool call/failure, an unrecognized
      // shape) ends whatever delta run was in progress and starts a fresh unit.
      flushDelta();
      deltaBufferOpen = false;

      if (sig.progress) {
        const kind = sig.progressKind ?? "status";
        let text = sig.progress;
        if (kind === "narrative") {
          if (anyNarrativeEmitted) text = `\n\n${text}`;
          anyNarrativeEmitted = true;
        }
        onProgress(text, kind);
        if (transcriptLen < 8000) {
          parts.push(sig.progress);
          transcriptLen += sig.progress.length + 1;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      // Mirror raw opencode output to our own stdout as it arrives so
      // `kubectl logs -f` shows progress live instead of only at process
      // exit (previously this was only ever written once, in the `close`
      // handler below, which made the pod look hung until the job finished).
      process.stdout.write(s);
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
  anthropicApiKey: string,
  turnStartedAt: number,
): Promise<{ reply: string; nextMarker: SweMarker | null; succeeded: boolean }> {
  const apiHost = new URL(toolConfig.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(toolConfig.githubApiUrl).host;

  // Dual-token identity delegation (docs/adr — see identityDelegation.ts):
  // when enabled, the user's own linked token only ever gates *whether* a
  // write happens; the write itself is done with a freshly minted App
  // installation token, so commits/PRs attribute to the bot. Falls back to
  // resolveGithubToken's single-token behavior (static PAT, or whatever's
  // configured) when delegation isn't configured.
  const delegating = isDelegating(toolConfig);
  let token: string;
  let attribution: { githubLogin: string; githubId: number } | null = null;
  if (delegating) {
    try {
      const resolved = await resolveDelegatedToken(toolConfig, marker?.repo ?? null, turnStartedAt);
      token = resolved.token;
      attribution = resolved.attribution;
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return {
          reply: `You don't have write access to \`${marker?.repo}\`: ${err.message}`,
          nextMarker: marker,
          succeeded: false,
        };
      }
      throw err;
    }
  } else {
    token = await resolveGithubToken(toolConfig);
  }

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

  // Once delegating, the token authenticating git/gh is an installation
  // token, which can't call `GET /user` (403 — App tokens aren't user
  // tokens), so resolveGitIdentity's own lookup would always miss. Construct
  // the bot identity directly when the App's slug is configured; otherwise
  // fall back to the generic placeholder (unchanged prior behavior).
  const identity =
    delegating && toolConfig.githubAppSlug
      ? {
          name: `${toolConfig.githubAppSlug}[bot]`,
          email: `${toolConfig.githubAppId}+${toolConfig.githubAppSlug}[bot]@users.noreply.github.com`,
        }
      : ((await resolveGitIdentity(childEnv, session.signal)) ?? {
          name: "opencode-swe",
          email: "opencode-swe@users.noreply.github.com",
        });
  await setupGitAuth({ homeDir: toolConfig.homeDir, token, apiHost, identity });

  await session.progress("Preparing workspace…");

  let priorHeadSha: string | null = null;
  if (marker?.repo) {
    const repoName = marker.repo.split("/")[1];
    const dest = `${toolConfig.workdir}/${repoName}`;
    const cloneResult = await runCommand("git", ["clone", `https://${apiHost}/${marker.repo}.git`, dest], {
      env: childEnv,
      signal: session.signal,
    });
    if (cloneResult.code === 0 && marker.branch) {
      await runCommand("git", ["-C", dest, "checkout", marker.branch], { env: childEnv, signal: session.signal });
    }
    if (cloneResult.code === 0) {
      const headRes = await runCommand("git", ["-C", dest, "rev-parse", "HEAD"], {
        env: childEnv,
        signal: session.signal,
      });
      if (headRes.code === 0) priorHeadSha = headRes.stdout.trim();
    }
  }

  await session.progress("Running coding agent…");
  const prompt = buildPrompt(instruction, marker);
  const args = buildOpencodeArgs({ prompt, workdir: toolConfig.workdir, model: toolConfig.model });

  const result = await runOpencode(
    args,
    childEnv,
    toolConfig.workdir,
    (text, kind) => {
      // "agent-text" is a contract with the orchestrator (server.ts): it streams
      // that stage's message as real chat content instead of a status spinner.
      void session.progress(clip(text, 500), { stage: kind === "narrative" ? "agent-text" : "agent" });
    },
    session.signal,
  );

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
  const discovered = repoDir ? await discoverResult(repoDir, childEnv, session.signal) : null;

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

  if (delegating && attribution) {
    // marker.repo known -> access was already verified pre-flight above.
    // marker.repo unknown -> this is the first point the actual repo is
    // known, so it's the first point we CAN check: distinguish "the bot
    // just created this" (grant the human access) from "this repo already
    // existed" (retroactively verify access; revoke the PR if insufficient)
    // via GitHub's own created_at timestamp — not the LLM's say-so.
    if (!marker?.repo) {
      const outcome = await finalizeDelegatedWrite({
        token,
        attribution,
        repo: discovered.repo,
        githubApiUrl: toolConfig.githubApiUrl,
        turnStartedAt,
      });
      if (outcome.kind === "revoke") {
        if (discovered.pr) {
          await runCommand(
            "gh",
            [
              "pr",
              "close",
              discovered.pr,
              "--repo",
              discovered.repo,
              "--comment",
              "Closed automatically: the initiating user does not have write access to this repository.",
            ],
            { env: childEnv, signal: session.signal },
          );
        }
        return {
          reply: `⚠️ This operation touched \`${discovered.repo}\`, which you don't have write access to (${outcome.reason}). The resulting change has been closed rather than reported as complete.`,
          nextMarker: marker,
          succeeded: false,
        };
      }
    }

    await appendCoAuthorTrailer(
      repoDir!,
      childEnv,
      { login: attribution.githubLogin, id: attribution.githubId },
      priorHeadSha,
    );
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
    reply: `${clip(summary, 1500)}${prLine}`,
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
 * Multi-turn continuity across separate AgentRun invocations (docs/adr/0017)
 * is maintained via the orchestrator's session store, not the chat
 * transcript: this agent's `reply.result` carries the encoded repo/branch/
 * pr/session as an opaque token (see ./marker.ts), and on the NEXT episode
 * the orchestrator prepends `<!-- continuation: <token> -->` to `goal` (see
 * ./continuation.ts for stripping it back off) — the value never appears in
 * anything the user or the orchestrator's LLM planner reads. Within a single
 * AgentRun episode (i.e. for HITL during one coding task) we use native
 * `session.ask()` to pause and resume instead.
 */
runAgent(async (session) => {
  const turnStartedAt = Date.now();
  const anthropicApiKey = toolConfig.anthropicApiKey;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required — inject via secretEnv/secretKeyRef on the Agent CR");
  }

  await ensureDir(toolConfig.homeDir);
  await ensureDir(toolConfig.workdir);

  await session.progress("Authenticating…", { stage: "authenticate" });

  // Strip the generic continuation marker (if this is a continuation
  // episode) and decode it back into repo/branch/pr/session.
  const { token: continuationToken, text: instruction } = extractContinuationToken(session.goal);
  const marker = decodeSweContinuation(continuationToken);
  if (!instruction.trim()) {
    throw new Error("Goal must not be empty after removing any continuation marker");
  }

  // If the instruction is genuinely ambiguous (e.g. no target repo specified
  // and no prior marker), ask for clarification before spinning up opencode.
  // Note: this is currently a simple heuristic — a more sophisticated agent
  // would use an LLM pre-flight check here. For now, always proceed to the
  // coding turn and let the opencode CLI surface missing-context errors.
  // (Token resolution — including the dual-token identity-delegation path —
  // happens inside runOneTurn, since it needs `marker` to decide whether the
  // target repo is already known.)
  const { reply, nextMarker, succeeded } = await runOneTurn(session, instruction, marker, anthropicApiKey, turnStartedAt);

  if (!succeeded) {
    throw new Error(reply);
  }

  return { message: reply, result: nextMarker ? encodeSweContinuation(nextMarker) : undefined };
});
