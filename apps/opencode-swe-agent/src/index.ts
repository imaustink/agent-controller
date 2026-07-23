import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, NatsChannel, type AgentChannel } from "@controller-agent/agent-runtime";
import type { AgentDownMessage, AgentUpMessage } from "@controller-agent/messaging";
import { buildOpencodeConfig, buildPrompt } from "./opencode.js";
import {
  createSession,
  forwardRequest,
  sendMessage,
  startOpencodeServer,
  subscribeEvents,
  type OpencodeAuth,
  type OpencodeServerHandle,
} from "./opencode-server.js";
import { appendCoAuthorTrailer, discoverResult, ensureDir, findRepoDir, resolveGitIdentity, runCommand, setupGitAuth } from "./git.js";
import { extractContinuationToken } from "./continuation.js";
import { decodeSweContinuation, encodeSweContinuation, type SweMarker } from "./marker.js";
import { loadToolConfig } from "./config.js";
import { resolveGithubToken } from "@controller-agent/github-app-auth";
import { AuthorizationError, finalizeDelegatedWrite, isDelegating, resolveDelegatedToken } from "./identityDelegation.js";
import { clip } from "./security/redact.js";

const toolConfig = loadToolConfig();

/** Distributive Omit so each union variant keeps its own fields (a plain Omit over a union keeps only common keys). */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "agent_run_id" | "seq" | "ts"> : never;

const OPENCODE_PORT = 4096;

interface TurnOutcome {
  reply: string;
  nextMarker: SweMarker | null;
  succeeded: boolean;
}

interface TurnContext {
  serverBaseUrl: string;
  auth: OpencodeAuth;
  sessionId: string;
  childEnv: NodeJS.ProcessEnv;
  apiHost: string;
  token: string;
  delegating: boolean;
  attribution: { githubLogin: string; githubId: number } | null;
  turnStartedAt: number;
  signal: AbortSignal;
}

/**
 * Runs one turn against the already-running opencode session: clones/checks
 * out the target repo (first turn of a continuation only -- later turns
 * reuse the same on-disk clone, since the Pod itself now persists across
 * turns instead of restarting per turn), sends the instruction, and applies
 * the same post-processing as before ADR 0026 (PR discovery, identity-
 * delegation finalize/revoke, co-author trailer, continuation marker).
 */
async function runTurn(ctx: TurnContext, instruction: string, marker: SweMarker | null, isFirstTurn: boolean): Promise<TurnOutcome> {
  if (isFirstTurn && marker?.repo) {
    const repoName = marker.repo.split("/")[1];
    const dest = `${toolConfig.workdir}/${repoName}`;
    const cloneResult = await runCommand("git", ["clone", `https://${ctx.apiHost}/${marker.repo}.git`, dest], {
      env: ctx.childEnv,
      signal: ctx.signal,
    });
    if (cloneResult.code === 0 && marker.branch) {
      await runCommand("git", ["-C", dest, "checkout", marker.branch], { env: ctx.childEnv, signal: ctx.signal });
    }
  }

  let priorHeadSha: string | null = null;
  const repoDirBeforeTurn = await findRepoDir(toolConfig.workdir);
  if (repoDirBeforeTurn) {
    const headRes = await runCommand("git", ["-C", repoDirBeforeTurn, "rev-parse", "HEAD"], {
      env: ctx.childEnv,
      signal: ctx.signal,
    });
    if (headRes.code === 0) priorHeadSha = headRes.stdout.trim();
  }

  // Only the FIRST turn gets the full framing prompt (workflow rules,
  // environment description, continuation context) -- opencode already has
  // that context in the session's own history for every turn after.
  const promptText = isFirstTurn ? buildPrompt(instruction, marker) : instruction;
  const result = await sendMessage(ctx.serverBaseUrl, ctx.sessionId, promptText, ctx.auth, ctx.signal);

  if (result.failed) {
    return {
      reply: `The coding agent reported an error${result.failureDetail ? `: ${clip(result.failureDetail, 800)}` : ""}`,
      nextMarker: marker,
      succeeded: false,
    };
  }

  const summary = clip(result.finalMessage ?? "The coding agent finished without a summary.", 4000);
  const repoDir = await findRepoDir(toolConfig.workdir);
  const discovered = repoDir ? await discoverResult(repoDir, ctx.childEnv, ctx.signal) : null;

  if (!discovered?.repo || !discovered.branch) {
    return {
      reply: `The agent produced no pushable repository or pull request. Details: ${clip(summary, 1200)}`,
      nextMarker: marker,
      succeeded: false,
    };
  }

  if (ctx.delegating && ctx.attribution) {
    if (!marker?.repo) {
      const outcome = await finalizeDelegatedWrite({
        token: ctx.token,
        attribution: ctx.attribution,
        repo: discovered.repo,
        githubApiUrl: toolConfig.githubApiUrl,
        turnStartedAt: ctx.turnStartedAt,
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
            { env: ctx.childEnv, signal: ctx.signal },
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
      ctx.childEnv,
      { login: ctx.attribution.githubLogin, id: ctx.attribution.githubId },
      priorHeadSha,
    );
  }

  const nextMarker: SweMarker = {
    repo: discovered.repo,
    branch: discovered.branch,
    pr: discovered.pr,
    session: marker?.session ?? ctx.sessionId,
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
 * Agent entry point (ADR 0026). Bypasses `runAgent()` -- its contract is
 * deliberately "one goal in, one reply out, then exit," which every other
 * agent relies on unchanged; generalizing it just for this one agent would
 * ripple everywhere. Instead this drives the lower-level primitives
 * `runAgent` itself is built on (`loadConfig()` + `NatsChannel`) directly, so
 * the process can stay resident: spawn a long-lived `opencode serve`
 * (loopback-only), run the initial goal, publish the exact same final
 * `reply`/continuation-token contract as before this ADR, then -- instead of
 * exiting -- stay up for a bounded idle window, tunneling a live viewer's
 * `opencode_request`s straight into the local server and forwarding its
 * `/event` SSE stream out as `opencode_event`s.
 */
async function main(): Promise<void> {
  const runtimeConfig = loadConfig();
  const channel: AgentChannel = await NatsChannel.connect(runtimeConfig);

  let seq = 0;
  // Plain `Omit` over a union collapses to only the common keys -- this
  // distributive form (matching `packages/agent-runtime`'s own internal
  // `WithoutEnvelope`) keeps each variant's own fields intact.
  const publishUp = (msg: WithoutEnvelope<AgentUpMessage>): Promise<void> =>
    channel.publishUp({
      ...msg,
      agent_run_id: runtimeConfig.runId,
      seq: seq++,
      ts: new Date().toISOString(),
    } as AgentUpMessage);

  const abort = new AbortController();
  let server: OpencodeServerHandle | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;

  const endSession = async (reason: string): Promise<void> => {
    if (ended) return;
    ended = true;
    if (idleTimer) clearTimeout(idleTimer);
    abort.abort(new Error(reason));
    await publishUp({ type: "session_ended", reason }).catch(() => {});
    server?.kill();
    await channel.close();
    process.exit(0);
  };

  const scheduleIdleShutdown = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    const liveUntil = new Date(Date.now() + toolConfig.liveIdleTimeoutMs).toISOString();
    void publishUp({ type: "session_idle", liveUntil });
    idleTimer = setTimeout(() => void endSession("idle timeout"), toolConfig.liveIdleTimeoutMs);
  };

  channel.onDown((msg: AgentDownMessage) => {
    switch (msg.type) {
      case "opencode_request":
        if (!server) {
          void publishUp({ type: "opencode_response", requestId: msg.requestId, status: 503, body: { error: "opencode server not ready" } });
          return;
        }
        // Any live-viewer activity resets the idle clock (only meaningful
        // once we've actually gone idle; harmless no-op before that).
        if (idleTimer) scheduleIdleShutdown();
        forwardRequest(server.baseUrl, { method: msg.method, path: msg.path, body: msg.body }, server.auth)
          .then((res) => publishUp({ type: "opencode_response", requestId: msg.requestId, status: res.status, body: res.body }))
          .catch((err) =>
            publishUp({
              type: "opencode_response",
              requestId: msg.requestId,
              status: 502,
              body: { error: err instanceof Error ? err.message : String(err) },
            }),
          );
        return;
      case "cancel":
        void endSession(msg.reason ?? "cancelled");
        return;
      case "prompt":
      case "signal":
        // This agent never calls ask() (no pending-answer HITL), and once a
        // final reply is sent the orchestrator no longer considers this run
        // "active" for ordinary conversational routing -- a live viewer's
        // follow-up prompt arrives as `opencode_request`, not `prompt`. Any
        // `prompt` here is therefore unexpected; drop it (same discipline as
        // `packages/agent-runtime`'s own `onDown` handler).
        return;
    }
  });

  await publishUp({ type: "ready" });

  try {
    const anthropicApiKey = toolConfig.anthropicApiKey;
    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required — inject via secretEnv/secretKeyRef on the Agent CR");
    }

    await ensureDir(toolConfig.homeDir);
    await ensureDir(toolConfig.workdir);

    await publishUp({ type: "progress", message: "Authenticating…", stage: "authenticate" });

    const { token: continuationToken, text: instruction } = extractContinuationToken(runtimeConfig.goal);
    const marker = decodeSweContinuation(continuationToken);
    if (!instruction.trim()) {
      throw new Error("Goal must not be empty after removing any continuation marker");
    }

    const turnStartedAt = Date.now();
    const apiHost = new URL(toolConfig.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(toolConfig.githubApiUrl).host;

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
          await publishUp({
            type: "reply",
            message: `You don't have write access to \`${marker?.repo}\`: ${err.message}`,
            final: true,
          });
          await endSession("unauthorized");
          return;
        }
        throw err;
      }
    } else {
      token = await resolveGithubToken(toolConfig);
    }

    const xdgConfigHome = `${toolConfig.homeDir}/.config`;
    const xdgDataHome = `${toolConfig.homeDir}/.local/share`;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: toolConfig.homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
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

    const identity =
      delegating && toolConfig.githubAppSlug
        ? {
            name: `${toolConfig.githubAppSlug}[bot]`,
            email: `${toolConfig.githubAppId}+${toolConfig.githubAppSlug}[bot]@users.noreply.github.com`,
          }
        : ((await resolveGitIdentity(childEnv, abort.signal)) ?? {
            name: "opencode-swe",
            email: "opencode-swe@users.noreply.github.com",
          });
    await setupGitAuth({ homeDir: toolConfig.homeDir, token, apiHost, identity });

    await publishUp({ type: "progress", message: "Starting opencode…" });
    server = startOpencodeServer({ port: OPENCODE_PORT, cwd: toolConfig.workdir, env: childEnv });
    await server.waitForHealth();

    const session = await createSession(server.baseUrl, server.auth);
    // Forward every local opencode event onto NATS for a live viewer
    // (ADR 0026) -- fire-and-forget, never awaited; never load-bearing for
    // the reply/prompt contract below.
    void subscribeEvents(server.baseUrl, server.auth, (event) => void publishUp({ type: "opencode_event", event }), abort.signal);

    await publishUp({ type: "progress", message: "Running coding agent…", stage: "agent" });
    const outcome = await runTurn(
      {
        serverBaseUrl: server.baseUrl,
        auth: server.auth,
        sessionId: session.id,
        childEnv,
        apiHost,
        token,
        delegating,
        attribution,
        turnStartedAt,
        signal: abort.signal,
      },
      instruction,
      marker,
      true,
    );

    if (!outcome.succeeded) {
      await publishUp({ type: "failed", code: "agent_error", message: outcome.reply });
      await endSession("turn failed");
      return;
    }

    await publishUp({
      type: "reply",
      message: outcome.reply,
      final: true,
      result: outcome.nextMarker ? encodeSweContinuation(outcome.nextMarker) : undefined,
    });

    // Stay resident instead of exiting immediately -- a live viewer can keep
    // tunneling `opencode_request`s into this same session until the idle
    // window (reset by any such activity) elapses.
    scheduleIdleShutdown();
  } catch (err) {
    if (!ended) {
      await publishUp({ type: "failed", code: "agent_error", message: err instanceof Error ? err.message : String(err) }).catch(() => {});
      await endSession("startup error");
    }
  }
}

void main();
