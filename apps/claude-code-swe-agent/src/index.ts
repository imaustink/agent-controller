import { randomUUID } from "node:crypto";
import { runAgent, type AgentReply, type AgentSession } from "@controller-agent/agent-runtime";
import { resolveGithubToken } from "@controller-agent/github-app-auth";
import { buildClaudeSettings, buildPrompt } from "./claude.js";
import { runClaudeTurn } from "./claude-runner.js";
import {
  appendCoAuthorTrailer,
  discoverResult,
  ensureDir,
  findRepoDir,
  resolveGitIdentity,
  runCommand,
  setupGitAuth,
} from "./git.js";
import { extractContinuationToken } from "./continuation.js";
import { decodeSweContinuation, encodeSweContinuation, type SweMarker } from "./marker.js";
import { loadToolConfig } from "./config.js";
import { AuthorizationError, finalizeDelegatedWrite, isDelegating, resolveDelegatedToken } from "./identityDelegation.js";
import { clip } from "./security/redact.js";

const toolConfig = loadToolConfig();

/**
 * Agent entry point. Uses the plain `runAgent()` contract (one goal in, one
 * reply out, then exit) -- unlike opencode-swe-agent (ADR 0026), there is no
 * long-lived local server for this agent to keep resident and tunnel: each
 * AgentRun is a single `claude -p` invocation. Multi-turn continuity across
 * separate AgentRuns comes entirely from re-cloning the repo/branch and
 * re-framing the task with the saved PR context (see marker.ts/claude.ts).
 */
async function handler(session: AgentSession): Promise<AgentReply> {
  if (!toolConfig.anthropicApiKey && !toolConfig.claudeCodeOAuthToken) {
    throw new Error(
      "Either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required — inject via secretEnv/secretKeyRef on the Agent CR",
    );
  }

  await ensureDir(toolConfig.homeDir);
  await ensureDir(toolConfig.workdir);

  await session.progress("Authenticating…", { stage: "authenticate" });

  const { token: continuationToken, text: instruction } = extractContinuationToken(session.goal);
  const marker = decodeSweContinuation(continuationToken);
  if (!instruction.trim()) {
    throw new Error("Goal must not be empty after removing any continuation marker");
  }

  const turnStartedAt = Date.now();
  const apiHost =
    new URL(toolConfig.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(toolConfig.githubApiUrl).host;

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
        return { message: `You don't have write access to \`${marker?.repo}\`: ${err.message}` };
      }
      throw err;
    }
  } else {
    token = await resolveGithubToken(toolConfig);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: toolConfig.homeDir,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };
  // Claude Code CLI prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY
  // when both are set; drop the API key entirely when a delegated/static
  // OAuth token is present so there's no ambiguity about which credential is
  // actually in effect.
  if (toolConfig.claudeCodeOAuthToken) {
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = toolConfig.claudeCodeOAuthToken;
    delete childEnv.ANTHROPIC_API_KEY;
  } else {
    childEnv.ANTHROPIC_API_KEY = toolConfig.anthropicApiKey;
  }

  const identity =
    delegating && toolConfig.githubAppSlug
      ? {
          name: `${toolConfig.githubAppSlug}[bot]`,
          email: `${toolConfig.githubAppId}+${toolConfig.githubAppSlug}[bot]@users.noreply.github.com`,
        }
      : ((await resolveGitIdentity(childEnv, session.signal)) ?? {
          name: "claude-code-swe",
          email: "claude-code-swe@users.noreply.github.com",
        });
  await setupGitAuth({ homeDir: toolConfig.homeDir, token, apiHost, identity });

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
  }

  let priorHeadSha: string | null = null;
  const repoDirBeforeTurn = await findRepoDir(toolConfig.workdir);
  if (repoDirBeforeTurn) {
    const headRes = await runCommand("git", ["-C", repoDirBeforeTurn, "rev-parse", "HEAD"], {
      env: childEnv,
      signal: session.signal,
    });
    if (headRes.code === 0) priorHeadSha = headRes.stdout.trim();
  }

  await session.progress("Running Claude Code…", { stage: "agent" });
  const prompt = buildPrompt(instruction, marker);
  const outcome = await runClaudeTurn(prompt, {
    cwd: toolConfig.workdir,
    env: childEnv,
    settings: buildClaudeSettings(),
    model: toolConfig.model || undefined,
    signal: session.signal,
    onProgress: (message, stage) => void session.progress(clip(message, 500), { stage }),
  });

  if (outcome.failed) {
    // Phase 3 (per-user Claude OAuth delegation, docs/adr/0027) will teach
    // agent-orchestrator to react to `outcome.authError` distinctly (trigger
    // re-auth instead of just reporting failure) -- today's plain
    // `runAgent()` contract has no channel for a custom failure code, so for
    // now this only affects the message text a human reads.
    const detail = outcome.failureDetail ?? "Claude Code reported an error";
    throw new Error(
      outcome.authError
        ? `Claude Code's credentials look expired or invalid: ${detail}`
        : `The coding agent reported an error: ${clip(detail, 800)}`,
    );
  }

  const summary = clip(outcome.finalMessage ?? "Claude Code finished without a summary.", 4000);
  const repoDir = await findRepoDir(toolConfig.workdir);
  const discovered = repoDir ? await discoverResult(repoDir, childEnv, session.signal) : null;

  if (!discovered?.repo || !discovered.branch) {
    return { message: `The agent produced no pushable repository or pull request. Details: ${clip(summary, 1200)}` };
  }

  if (delegating && attribution) {
    if (!marker?.repo) {
      const outcome2 = await finalizeDelegatedWrite({
        token,
        attribution,
        repo: discovered.repo,
        githubApiUrl: toolConfig.githubApiUrl,
        turnStartedAt,
      });
      if (outcome2.kind === "revoke") {
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
          message: `⚠️ This operation touched \`${discovered.repo}\`, which you don't have write access to (${outcome2.reason}). The resulting change has been closed rather than reported as complete.`,
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

  return { message: `${clip(summary, 1500)}${prLine}`, result: encodeSweContinuation(nextMarker) };
}

void runAgent(handler);
