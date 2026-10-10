import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentFailure, runAgent, type AgentReply, type AgentSession } from "@controller-agent/agent-runtime";
import { buildClaudeSettings, buildPrompt, isReviewMode } from "./claude.js";
import { runClaudeTurn, runClaudeTurnRemoteControlled } from "./claude-runner.js";
import {
  appendCoAuthorTrailer,
  countCommitsAheadOfOriginHead,
  discoverResult,
  ensureChangeDeliverable,
  ensureDir,
  ensurePullRequest,
  findRepoDir,
  resolveGitIdentity,
  runCommand,
  setupGitAuth,
} from "./git.js";
import { extractContinuationToken } from "./continuation.js";
import { decodeSweContinuation, encodeSweContinuation, type SweMarker } from "./marker.js";
import { loadToolConfig } from "./config.js";
import { createCredentialsWritebackWatcher, credentialExpiry } from "./credentialsWriteback.js";
import {
  AuthorizationError,
  finalizeDelegatedWrite,
  isDelegating,
  resolveDelegatedToken,
  resolveUndelegatedToken,
} from "./identityDelegation.js";
import { GH_READ_TOKEN_ENV, GH_WRITE_TOKEN_ENV, installGhShim } from "./ghShim.js";
import { clip } from "./security/redact.js";
import { listInstalledSkills, splitSkillInvocation } from "./skills.js";

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
  // Remote Control authenticates from the seeded ~/.claude/.credentials.json
  // full login instead of an env credential (see the childEnv block below),
  // so neither of these is required in that mode.
  if (!toolConfig.remoteControlEnabled && !toolConfig.anthropicApiKey && !toolConfig.claudeCodeOAuthToken) {
    throw new Error(
      "Either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required — inject via secretEnv/secretKeyRef on the Agent CR",
    );
  }

  await ensureDir(toolConfig.homeDir);
  await ensureDir(toolConfig.workdir);
  const installedSkills = await listInstalledSkills(toolConfig.homeDir);

  if (toolConfig.remoteControlEnabled) {
    // A separate Go/Helm phase's init container is responsible for seeding
    // the credentials file before the Job container starts (see config.ts's
    // `homeDir`/`remoteControlEnabled` docs) -- its absence here is logged,
    // not thrown, both because that phase's exact seeding behavior can't be
    // verified from this app, and because `claude --remote-control` itself is
    // the actual authority on whether the run can proceed; failing fast here
    // on a wrong guess would be worse than letting it fail with a real error.
    const credentialsPath = join(toolConfig.homeDir, ".claude", ".credentials.json");
    if (!existsSync(credentialsPath)) {
      console.error(
        `[claude-code-swe-agent] CLAUDE_REMOTE_CONTROL is enabled but no credentials file was found at ${credentialsPath} -- ` +
          "the Remote Control turn will likely fail to authenticate unless the init container seeds it before this point.",
      );
    }
    // State the expiry of the credential this run was handed, so "was it
    // already dead when we injected it?" is answerable from the log instead of
    // being reconstructed from when a comment appeared. Expiry only -- never
    // any token material.
    if (toolConfig.loginCredentialsJson) {
      const expiry = credentialExpiry(toolConfig.loginCredentialsJson);
      const relative = expiry ? `${Math.round((Date.parse(expiry) - Date.now()) / 60_000)} min from now` : "unknown";
      console.error(`[claude-code-swe-agent] seeded Remote Control credential expires ${expiry ?? "unknown"} (${relative})`);
    }

    // `claude --bg` combined with bypassPermissions refuses to start
    // ("requires accepting the disclaimer first") unless
    // ~/.claude/settings.json has `skipDangerousModePermissionPrompt: true`
    // ON DISK -- confirmed empirically (diffing a real interactive
    // acceptance in a throwaway pod on this same image) that the CLI's `-p`/
    // `--bg` `--settings` flag does NOT satisfy this specific check; only
    // the literal on-disk file does. Written directly here (not via the
    // credentials-seeding init container) since this is a fixed,
    // account-independent value -- no per-user credential involved.
    const settingsPath = join(toolConfig.homeDir, ".claude", "settings.json");
    await ensureDir(join(toolConfig.homeDir, ".claude"));
    let existingSettings: Record<string, unknown> = {};
    try {
      existingSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch {
      // No existing settings.json (the common case) or it's not valid JSON
      // -- either way, start fresh rather than fail the turn over this.
    }
    await writeFile(
      settingsPath,
      JSON.stringify({ ...existingSettings, skipDangerousModePermissionPrompt: true }, null, 2),
    );
  }

  await session.progress("Authenticating…", { stage: "authenticate" });

  const { token: continuationToken, text: goalText } = extractContinuationToken(session.goal);
  const marker = decodeSweContinuation(continuationToken);
  const { skill, instruction } = splitSkillInvocation(goalText, installedSkills);
  if (!instruction.trim()) {
    throw new Error("Goal must not be empty after removing any continuation marker");
  }

  // A review run is recognised STRUCTURALLY from an exact sentinel the review
  // IntegrationRoute placed in the goal (see claude.ts's REVIEW_MODE_MARKER),
  // not from the model's prose or a configurable label. It drives two
  // code-level guards below: the CLI permission deny list (buildClaudeSettings)
  // and a read-only GitHub token (the reviewMode arg to the token resolvers).
  // Detected on the full goal so a continuation marker can't hide it.
  const reviewMode = isReviewMode(session.goal);
  if (reviewMode) {
    console.error("[claude-code-swe-agent] review mode: enforcing read-only (deny push/PR create/merge, read-only token)");
  }

  const turnStartedAt = Date.now();
  const apiHost =
    new URL(toolConfig.githubApiUrl).host === "api.github.com" ? "github.com" : new URL(toolConfig.githubApiUrl).host;

  const delegating = isDelegating(toolConfig);
  // Two credentials when delegating (docs/adr/0041): reads run as the human
  // who asked, writes run as the App. They collapse to one token otherwise,
  // which is exactly the pre-existing single-token behaviour.
  let readToken: string;
  let writeToken: string;
  let attribution: { githubLogin: string; githubId?: number } | null = null;
  if (delegating) {
    try {
      const resolved = await resolveDelegatedToken(toolConfig, marker?.repo ?? null, reviewMode, turnStartedAt);
      readToken = resolved.readToken;
      writeToken = resolved.writeToken;
      attribution = resolved.attribution;
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return { message: `You don't have write access to \`${marker?.repo}\`: ${err.message}` };
      }
      throw err;
    }
  } else {
    readToken = writeToken = await resolveUndelegatedToken(toolConfig, reviewMode);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: toolConfig.homeDir,
    // The read credential is the default for anything that reads GH_TOKEN
    // directly. `gh` itself goes through the shim below, which overrides this
    // per invocation; this value is what a non-delegating run always used.
    GH_TOKEN: readToken,
    GITHUB_TOKEN: readToken,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (delegating) {
    const shim = await installGhShim({ homeDir: toolConfig.homeDir });
    if (shim) {
      childEnv.PATH = `${shim.binDir}:${childEnv.PATH ?? ""}`;
      childEnv[GH_READ_TOKEN_ENV] = readToken;
      childEnv[GH_WRITE_TOKEN_ENV] = writeToken;
    } else {
      // Not fatal, but it means every `gh` call -- including `pr create` --
      // runs on the read credential, so PR creation will fail rather than
      // quietly running with the App's wider access. Said out loud because
      // the symptom (a permissions error on push/PR) points nowhere near it.
      console.error(
        "[identity-delegation] could not install the gh credential shim; gh will run entirely on the read token, " +
          "so writes performed through gh (e.g. `gh pr create`) will fail",
      );
    }
  }
  // Model-credential selection.
  //
  // Remote Control is the exception and MUST come first: it refuses to
  // establish a session when the CLI is authenticated via
  // CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY ("these tokens can only make
  // model requests"), and an env credential takes precedence over the
  // on-disk ~/.claude/.credentials.json. So when remote control is enabled we
  // deliberately inject NEITHER -- forcing the CLI to use the full-login
  // credentials.json the init container seeded (its `user:inference` scope
  // covers model calls too). Confirmed empirically: with CLAUDE_CODE_OAUTH_TOKEN
  // present the bridge silently never registers (task still runs, but no URL);
  // with it absent the bridge registers and the claude.ai/code URL appears.
  //
  // Otherwise (one-shot `-p` path): the CLI prefers CLAUDE_CODE_OAUTH_TOKEN
  // over ANTHROPIC_API_KEY when both are set; drop the API key when an OAuth
  // token is present so there's no ambiguity about which credential is in
  // effect.
  if (toolConfig.remoteControlEnabled) {
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete childEnv.ANTHROPIC_API_KEY;
  } else if (toolConfig.claudeCodeOAuthToken) {
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
  await setupGitAuth({ homeDir: toolConfig.homeDir, token: readToken, pushToken: writeToken, apiHost, identity });

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
  const prompt = buildPrompt(instruction, marker, skill);
  const runOpts = {
    cwd: toolConfig.workdir,
    env: childEnv,
    settings: buildClaudeSettings(reviewMode),
    model: toolConfig.model || undefined,
    signal: session.signal,
    onProgress: (message: string, stage: string) => void session.progress(clip(message, 500), { stage }),
  };
  // Persist any credential refresh DURING the turn, not only after it. The
  // refresh rotates the stored refresh token, so a refresh this pod fails to
  // report kills the link outright -- see ./credentialsWriteback.ts. Started
  // before the turn so a pod killed mid-turn has already reported whatever the
  // CLI refreshed seconds into it.
  const writebackWatcher = createCredentialsWritebackWatcher({
    homeDir: toolConfig.homeDir,
    url: toolConfig.credentialsWritebackUrl,
    token: toolConfig.credentialsWritebackToken,
    seeded: toolConfig.loginCredentialsJson,
  });
  writebackWatcher.start();

  const outcome = toolConfig.remoteControlEnabled
    ? await runClaudeTurnRemoteControlled(prompt, {
        ...runOpts,
        runId: session.runId,
        ...(toolConfig.remoteControlIdleTimeoutMs ? { idleTimeoutMs: toolConfig.remoteControlIdleTimeoutMs } : {}),
        ...(toolConfig.remoteControlIdleStatusGraceMs ? { idleStatusGraceMs: toolConfig.remoteControlIdleStatusGraceMs } : {}),
        ...(toolConfig.remoteControlWaitingTimeoutMs ? { waitingTimeoutMs: toolConfig.remoteControlWaitingTimeoutMs } : {}),
        ...(toolConfig.remoteControlMaxWaitMs ? { maxWaitMs: toolConfig.remoteControlMaxWaitMs } : {}),
      })
    : await runClaudeTurn(prompt, runOpts);

  // Runs on every outcome, including a failed one: the CLI may well have
  // refreshed its credential before whatever went wrong, and that refresh
  // invalidated the stored copy either way (see ./credentialsWriteback.ts).
  // Retried internally, so a gateway mid-rollout does not cost the link.
  const writeback = await writebackWatcher.stop();
  if (writeback !== "disabled" && writeback !== "unchanged") {
    console.error(`[claude-code-swe-agent] credential write-back: ${writeback}`);
  }

  if (outcome.failed) {
    const detail = outcome.failureDetail ?? "Claude Code reported an error";
    if (outcome.authError) {
      // A coded failure, not a plain Error: this is the one agent failure the
      // orchestrator can actually recover from (docs/adr/0027's re-auth path
      // -- invalidate the stale stored credential, then prompt the user to
      // re-link on the next trigger), and it can only do that if it can tell
      // this apart from an ordinary task failure. The code says WHICH stored
      // credential to drop: Remote Control authenticates from the
      // `claude-remote` login blob, every other mode from the `claude`
      // setup-token, and dropping the wrong one leaves the bad credential in
      // place to fail again.
      throw new AgentFailure(
        toolConfig.remoteControlEnabled ? "claude_remote_auth_expired" : "claude_auth_expired",
        `Claude Code's credentials look expired or invalid: ${clip(detail, 800)}`,
      );
    }
    throw new Error(`The coding agent reported an error: ${clip(detail, 800)}`);
  }

  const summary = clip(outcome.finalMessage ?? "Claude Code finished without a summary.", 4000);
  const repoDir = await findRepoDir(toolConfig.workdir);

  // FIX (deterministic deliverable): on a CHANGE turn the runner itself commits
  // any dirty tree and pushes the feature branch, so producing pushable work no
  // longer depends on the model remembering to run the right git commands. A
  // review turn publishes nothing and is skipped (its token is read-only anyway).
  if (!reviewMode && repoDir) {
    const published = await ensureChangeDeliverable(repoDir, childEnv, session.signal);
    if (published.committed || published.pushed) {
      console.error(
        `[claude-code-swe-agent] runner-owned deliverable: committed=${published.committed} pushed=${published.pushed} branch=${published.branch ?? "?"}`,
      );
    }
  }

  const discovered = repoDir ? await discoverResult(repoDir, childEnv, session.signal) : null;

  if (!discovered?.repo || !discovered.branch) {
    // A CHANGE turn that produced no pushable repository/branch delivered
    // nothing; report a failure rather than a success with a note (the latter
    // hid turns that did nothing -- the model simply "forgot"). A review turn
    // legitimately produces no pushable branch, so there it stays a plain reply.
    if (!reviewMode) {
      throw new Error(`The coding agent produced no pushable repository or branch. Details: ${clip(summary, 1200)}`);
    }
    return { message: `The agent produced no pushable repository or pull request. Details: ${clip(summary, 1200)}` };
  }

  let headSha: string | null = null;
  const headResAfter = await runCommand("git", ["-C", repoDir!, "rev-parse", "HEAD"], {
    env: childEnv,
    signal: session.signal,
  });
  if (headResAfter.code === 0) headSha = headResAfter.stdout.trim();
  // "Did this turn commit pushable work?" When we captured a prior HEAD (the
  // repo existed before the turn -- a continuation, including review-only
  // turns), diff against it: an unchanged HEAD means no new commits. When we
  // did NOT (priorHeadSha === null -- the repo was cloned DURING the turn, as
  // on a first, marker-less chat turn), a non-null HEAD is just the clone's
  // base commit and is NOT evidence of new work; instead ask whether HEAD
  // moved past the clone's default-branch tip. This avoids the false "no open
  // pull request was found" warning on a turn that only read the repo (e.g.
  // to file an issue), which left HEAD exactly at origin/HEAD.
  const madeNewCommits =
    priorHeadSha !== null
      ? headSha !== null && headSha !== priorHeadSha
      : (await countCommitsAheadOfOriginHead(repoDir!, childEnv, session.signal)) > 0;

  // FIX (deterministic deliverable): on a CHANGE turn that produced commits but
  // no open PR, the runner opens one itself rather than warning the user that
  // the model forgot. Done BEFORE the delegating revoke check below so that, if
  // the user turns out to lack access, there is a PR to close. A review turn
  // never reaches here with commits (its token is read-only).
  if (!reviewMode && madeNewCommits && !discovered.pr) {
    const pr = await ensurePullRequest(discovered.repo, discovered.branch, childEnv, session.signal);
    if (pr) {
      discovered.pr = pr.number;
      discovered.prUrl = pr.url;
    }
  }

  if (delegating && attribution) {
    // A verified target repository needs no post-flight: the write token was
    // scoped to it before the run started, so there is nothing else the run
    // could have written to that would need granting or revoking.
    if (!marker?.repo && !toolConfig.targetRepository) {
      const outcome2 = await finalizeDelegatedWrite({
        // The App credential: this step reads repo metadata and may GRANT the
        // user access, neither of which the user's own token can do.
        token: writeToken,
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

  // FIX (honest failure): a CHANGE turn that produced neither new commits nor a
  // pull request delivered nothing. Report it as a failure rather than a success
  // carrying a "no open pull request was found" warning (which read as done).
  // A review turn makes no commits by design and is exempt.
  if (!reviewMode && !madeNewCommits && !discovered.pr) {
    throw new Error(
      `The coding agent finished without producing any commits or a pull request. Details: ${clip(summary, 1200)}`,
    );
  }

  const nextMarker: SweMarker = {
    repo: discovered.repo,
    branch: discovered.branch,
    pr: discovered.pr,
    session: marker?.session ?? randomUUID(),
  };

  // Only mention push/PR status when this turn actually produced new commits
  // -- a review-only turn (e.g. the "ai-review" label route, which is
  // explicitly told not to push) legitimately checks out a branch without
  // committing anything, and slapping a "no open pull request was found"
  // warning on that is a false positive, not a signal anything went wrong.
  const prLine = !madeNewCommits
    ? ""
    : discovered.prUrl
      ? `\n\n---\n✅ ${marker?.pr ? "Updated" : "Opened"} pull request: [${discovered.repo}#${discovered.pr}](${discovered.prUrl})`
      : `\n\n---\n⚠️ Work is on \`${discovered.repo}\` branch \`${discovered.branch}\`, but no open pull request was found.`;

  return { message: `${clip(summary, 1500)}${prLine}`, result: encodeSweContinuation(nextMarker) };
}

void runAgent(handler);
