import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GithubReplyClient } from "./github-client.js";
import type { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { IdentityLinkApi } from "./identity-link/api.js";
import { ClaudeAuthApi } from "./claude-auth/api.js";
import type { ClaudeSetupTokenFlows } from "./claude-auth/pty-setup-token.js";
import type { ClaudeLoginFlows } from "./claude-auth/pty-login.js";
import type { ClaudeTokenStore } from "./claude-auth/store.js";
import type { IdentityResolver } from "./identity.js";
import type { OrchestratorClient, OrchestratorInvokeResult } from "./orchestrator-client.js";
import { renderSessionPage } from "./session-page.js";
import type { SessionPageStore } from "./session-page-store.js";
import { parseGithubEvent, verifyGithubSignature, WebhookAuthError } from "./webhooks/github.js";

const SESSION_PAGE_PATH = /^\/sessions\/([^/]+)$/;
const SESSION_PROMPT_PATH = /^\/sessions\/([^/]+)\/prompts$/;
const SESSION_LIVE_EVENTS_PATH = /^\/sessions\/([^/]+)\/live-events$/;
const SESSION_LIVE_PROMPT_PATH = /^\/sessions\/([^/]+)\/live-prompt$/;

export interface GatewayServerOptions {
  githubWebhookSecret: string;
  identityResolver: IdentityResolver;
  orchestratorClient: OrchestratorClient;
  githubReplyClient: GithubReplyClient;
  /**
   * The label that triggers automated triage (ADR 0024,
   * `GATEWAY_GITHUB_TRIGGER_LABEL`) -- an `issues.labeled` webhook is only
   * actionable when the label applied is this one; any other label is
   * ignored. Empty string effectively disables the trigger (no label name
   * can ever match). Deliberately a label, not an assignee: GitHub App bot
   * users generally cannot be set as issue assignees.
   */
  githubTriggerLabel: string;
  /**
   * The label that triggers an automated PR review when applied to a pull
   * request (`pull_request.labeled`, `GATEWAY_GITHUB_REVIEW_LABEL`) --
   * sibling to `githubTriggerLabel` but for PRs, so review and triage stay
   * independent. Optional/empty disables it (no label name can ever match).
   * The review runs as whoever applied the label, so the bot loop-guard in
   * `identityResolver` means a human must apply it -- the agent that opened
   * the PR (a bot) cannot self-trigger a review of its own PR.
   */
  githubReviewLabel?: string;
  /** Called with any error from the background invoke-and-reply step; defaults to console.error. */
  onBackgroundError?: (error: unknown) => void;
  /**
   * The identity-link credential-broker API (docs on `IdentityLinkApi`) --
   * optional so existing GitHub-webhook-only callers/tests don't need to wire
   * it up. Both fields must be set together to enable `/identity-link/*`.
   */
  identityLinkLinker?: GithubDeviceFlowLinker;
  identityLinkToken?: string;
  /**
   * Per-user Claude Code OAuth `setup-token` flow (docs/adr/0027) -- a
   * sibling to identity-link above, but PTY-driven rather than an HTTP
   * device flow. All three must be set together (mirroring
   * `identityLinkLinker`/`identityLinkToken`'s pairing) to enable
   * `/claude-auth/*`; reuses `identityLinkToken` as its own bearer secret
   * rather than minting a new one. Requires `publicBaseUrl` (below) to be
   * set too, since the page link handed back needs a reachable host.
   */
  claudeAuthFlows?: ClaudeSetupTokenFlows;
  claudeAuthStore?: ClaudeTokenStore;
  /**
   * Full-login (`claude auth login --claudeai`) flows for Remote Control
   * (docs/adr/0027 follow-up) -- optional and additive alongside
   * `claudeAuthFlows` above: a subject's `mode=login` request 501s until this
   * is wired up, rather than falling back to `setup-token`. Reuses
   * `claudeAuthStore`/`identityLinkToken`/`publicBaseUrl` above, same as the
   * `setup-token` flow does, so no new config surface is required just to
   * make this reachable once a caller sets it.
   */
  claudeLoginFlows?: ClaudeLoginFlows;
  /**
   * Session-page feature (issue #81) -- both fields must be set together to
   * enable it: a "starting work" comment posted right when an
   * `issues.labeled` triage trigger fires (rather than only after the whole
   * turn completes), linking to a minimal `GET /sessions/:token` page that
   * shows that session's turn history and lets a caller `POST` it follow-up
   * prompts. Omitted entirely (leaving both undefined) preserves this
   * gateway's exact pre-#81 behavior -- no page routes are reachable.
   */
  sessionPageStore?: SessionPageStore;
  publicBaseUrl?: string;
}

/** `owner/repo#issueNumber` scoped session id -- see docs/integrations-gateway.md. */
export function sessionIdFor(owner: string, repo: string, issueNumber: number): string {
  return `github:${owner}/${repo}#${issueNumber}`;
}

/**
 * Consumer-facing HTTP surface for the GitHub Issues adapter: verifies each
 * webhook, maps it onto a per-issue orchestrator session, and relays the
 * eventual result back as an issue comment. See docs/integrations-gateway.md
 * -- only an explicit label application (`issues.labeled` with the
 * configured trigger label, or `pull_request.labeled` with the review label)
 * is ever actionable; an unlabeled `issues.opened`/`issue_comment.created` is
 * a strict no-op (`parseGithubEvent` maps it straight to `{ kind: "ignored" }`).
 */
export class GatewayServer {
  private server: Server | undefined;
  private readonly identityLinkApi: IdentityLinkApi | undefined;
  private readonly claudeAuthApi: ClaudeAuthApi | undefined;

  constructor(private readonly options: GatewayServerOptions) {
    this.identityLinkApi =
      options.identityLinkLinker && options.identityLinkToken
        ? new IdentityLinkApi(options.identityLinkLinker, options.identityLinkToken)
        : undefined;
    this.claudeAuthApi =
      options.claudeAuthFlows && options.claudeAuthStore && options.identityLinkToken && options.publicBaseUrl
        ? new ClaudeAuthApi(
            options.claudeAuthFlows,
            options.claudeAuthStore,
            options.identityLinkToken,
            options.publicBaseUrl,
            options.claudeLoginFlows,
          )
        : undefined;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error: unknown) => {
          console.error(error);
          if (!res.writableEnded) res.writeHead(500).end();
        });
      });
      this.server.listen(port, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhooks/github") {
      await this.handleGithubWebhook(req, res);
      return;
    }
    if (this.options.sessionPageStore) {
      const liveEventsMatch = req.method === "GET" ? SESSION_LIVE_EVENTS_PATH.exec(url.pathname) : null;
      if (liveEventsMatch) {
        await this.handleSessionLiveEvents(res, liveEventsMatch[1] as string);
        return;
      }
      const livePromptMatch = req.method === "POST" ? SESSION_LIVE_PROMPT_PATH.exec(url.pathname) : null;
      if (livePromptMatch) {
        await this.handleSessionLivePrompt(req, res, livePromptMatch[1] as string);
        return;
      }
      const pageMatch = req.method === "GET" ? SESSION_PAGE_PATH.exec(url.pathname) : null;
      if (pageMatch) {
        await this.handleSessionPage(res, pageMatch[1] as string);
        return;
      }
      const promptMatch = req.method === "POST" ? SESSION_PROMPT_PATH.exec(url.pathname) : null;
      if (promptMatch) {
        await this.handleSessionPrompt(req, res, promptMatch[1] as string);
        return;
      }
    }
    // The authcode callback route is intercepted BEFORE the bearer-gated
    // dispatch below -- it's hit directly by the end user's browser (via
    // GitHub's redirect), which cannot carry our internal bearer token, and
    // `identityLinkApi.handle`'s own bearer check would otherwise 401 it.
    if (this.identityLinkApi && (await this.identityLinkApi.handleCallback(req, res, url))) {
      return;
    }
    // Same reasoning as the identity-link callback above: the claude-auth
    // page/submit routes are hit directly by the human's browser (capability
    // via `flowId` in the URL, not a bearer token), so they must be
    // dispatched before `claudeAuthApi.handle`'s bearer check.
    if (this.claudeAuthApi && (await this.claudeAuthApi.handlePage(req, res, url))) {
      return;
    }
    if (this.claudeAuthApi && (await this.claudeAuthApi.handle(req, res, url))) {
      return;
    }
    if (this.identityLinkApi && (await this.identityLinkApi.handle(req, res, url))) {
      return;
    }
    res.writeHead(404).end();
  }

  private async handleGithubWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);

    try {
      verifyGithubSignature(rawBody, req.headers["x-hub-signature-256"] as string | undefined, this.options.githubWebhookSecret);
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        res.writeHead(401).end();
        return;
      }
      throw error;
    }

    const event = parseGithubEvent(req.headers["x-github-event"] as string | undefined, rawBody);

    // Always ack fast (GitHub's webhook delivery has a short timeout); any
    // orchestrator/GitHub-API work happens after the response is sent.
    res.writeHead(202).end();

    if (event.kind === "ignored") return;

    if (event.kind === "pull-request-labeled") {
      // Only actionable when the label applied is THE review label -- GitHub
      // sends `pull_request.labeled` for every label, not just this one.
      if (event.labelName !== this.options.githubReviewLabel) return;

      // Runs as whoever applied the label (same identity/permission gate as
      // the other kinds). The gateway drops bot-authored events, so the
      // agent that opened the PR can't self-trigger a review -- a human
      // applies the label to request one.
      const identity = await this.options.identityResolver.resolve(event.senderLogin, event.senderIsBot, {
        owner: event.owner,
        repo: event.repo,
      });
      if (!identity) return;

      // A PR and an issue never share a number in the same repo, so this
      // session id can't collide with a triaged issue's session id.
      const sessionId = sessionIdFor(event.owner, event.repo, event.prNumber);
      // Fallback request text -- only used if no IntegrationRoute CR matches
      // the `event` descriptor below (agent-orchestrator then falls back to
      // ordinary RAG skill retrieval over this text).
      const request = `Pull request #${event.prNumber} was labeled "${event.labelName}": ${event.title}\n\n${event.body}`.trim();

      this.relayAndReply(event.owner, event.repo, event.prNumber, request, sessionId, {
        source: "github",
        event: "pull_request",
        action: "labeled",
        owner: event.owner,
        repo: event.repo,
        prNumber: event.prNumber,
        title: event.title,
        body: event.body,
        senderLogin: event.senderLogin,
        labelName: event.labelName,
      }).catch(this.options.onBackgroundError ?? ((error: unknown) => console.error(error)));
      return;
    }

    if (event.kind === "issue-labeled") {
      // Only actionable when the label applied is THE trigger label --
      // GitHub sends `issues.labeled` for every label, not just this one.
      if (event.labelName !== this.options.githubTriggerLabel) return;

      // The sender here is whoever applied the label, not the bot -- same
      // identity/permission check as the other event kinds, gating on who
      // triggered the action.
      const identity = await this.options.identityResolver.resolve(event.senderLogin, event.senderIsBot, {
        owner: event.owner,
        repo: event.repo,
      });
      if (!identity) return;

      const sessionId = sessionIdFor(event.owner, event.repo, event.issueNumber);
      // Fallback request text -- only used if no IntegrationRoute CR matches
      // the `event` descriptor sent below (agent-orchestrator then falls
      // back to ordinary RAG skill retrieval over this text).
      const request = `Issue #${event.issueNumber} was labeled "${event.labelName}": ${event.title}\n\n${event.body}`.trim();

      this.relayAndReply(event.owner, event.repo, event.issueNumber, request, sessionId, {
        source: "github",
        event: "issues",
        action: "labeled",
        owner: event.owner,
        repo: event.repo,
        issueNumber: event.issueNumber,
        title: event.title,
        body: event.body,
        senderLogin: event.senderLogin,
        labelName: event.labelName,
      }).catch(this.options.onBackgroundError ?? ((error: unknown) => console.error(error)));
      return;
    }
  }

  private async relayAndReply(
    owner: string,
    repo: string,
    issueNumber: number,
    request: string,
    sessionId: string,
    event?: Record<string, string | number | undefined>,
  ): Promise<void> {
    // Only the deterministic issues.labeled trigger (the actual "triage"
    // path -- long-running investigate-and-PR work, ADR 0024) gets a
    // session page and an upfront comment; the `event` descriptor is only
    // ever set on that path (see `handleGithubWebhook`'s issue-labeled
    // branch), which doubles as the discriminator here. Ordinary
    // conversational opened/comment replies are meant to feel like
    // near-instant chat, so an extra comment there would just be noise.
    //
    // The gateway's own session page (ADR 0025/0026) is still created and
    // tracked here for debugging, but its URL is deliberately NEVER posted
    // to the issue -- the only thing posted up front is a real Claude Code
    // Remote Control link (`onRemoteControlUrl`, fired by a
    // `remote-control-url` progress event from the delegated agent), and
    // only once one genuinely exists. If Remote Control never activates for
    // this run (not configured for the Agent, or the CLI never hands back a
    // session), no upfront comment is posted at all -- silence, not a
    // placeholder link nobody asked to see, is the fallback. This was a
    // deliberate, explicit product decision after the old "Starting work...
    // {session page link}" comment kept appearing instead of the intended
    // Remote Control link.
    let onRemoteControlUrl: ((url: string) => Promise<void>) | undefined;
    if (event && this.options.sessionPageStore && this.options.publicBaseUrl) {
      await this.options.sessionPageStore.getOrCreate(sessionId, { owner, repo, issueNumber });
      let posted = false;
      onRemoteControlUrl = async (url) => {
        if (posted) return;
        posted = true;
        await this.options.githubReplyClient.postIssueComment(owner, repo, issueNumber, `Remote Control session: ${url}`);
      };
    }
    await this.runTurn(owner, repo, issueNumber, sessionId, request, event, undefined, onRemoteControlUrl);
  }

  /** How long to hold a triage turn open waiting for the user to finish linking their account before giving up (they can always re-trigger the issue later). Matches the link flow's own ~10-minute expiry. */
  private static readonly RESUME_WAIT_MS = 10 * 60 * 1000;

  /**
   * Shared by `relayAndReply` (webhook-triggered turns) and
   * `handleSessionPrompt` (turns submitted through an existing session
   * page). Tracks the turn in `sessionPageStore` when (and only when) an
   * entry for `sessionId` already exists -- `addTurn` is deliberately a
   * no-op otherwise, so a plain issue that was never triaged never gets a
   * page just because a turn ran on its session id.
   */
  private async runTurn(
    owner: string,
    repo: string,
    issueNumber: number,
    sessionId: string,
    request: string,
    event?: Record<string, string | number | undefined>,
    announce?: () => Promise<void>,
    onRemoteControlUrl?: (url: string) => Promise<void>,
  ): Promise<void> {
    // This relay has no browser -- always force device flow explicitly rather
    // than relying on agent-orchestrator's own default ("authcode", intended
    // for browser-based callers). `announce` fires once the turn is genuinely
    // running past any auth pre-flight -- `relayAndReply` no longer uses it
    // (it posts nothing until a real Remote Control URL exists), but
    // `orchestratorClient.invoke` still accepts it for any other caller that
    // wants an "actually running now" signal. `onRemoteControlUrl` (when set)
    // is only ever passed on the triage path (alongside `event`), see
    // `relayAndReply`. Only pass an `event` when there is one -- keeps the
    // call shape identical for the ordinary opened/comment paths.
    const invokeOnce = (): Promise<OrchestratorInvokeResult> =>
      event
        ? this.options.orchestratorClient.invoke(request, sessionId, "device", event, announce, onRemoteControlUrl)
        : this.options.orchestratorClient.invoke(request, sessionId, "device", undefined, announce, onRemoteControlUrl);

    const finishTurn = async (
      tracked: { turnIndex: number } | undefined,
      outcome: OrchestratorInvokeResult,
    ): Promise<void> => {
      const reply =
        outcome.status === "succeeded"
          ? (outcome.result ?? "")
          : `Something went wrong processing this: ${outcome.error ?? "unknown error"}`;
      if (tracked) {
        await this.options.sessionPageStore!.completeTurn(
          sessionId,
          tracked.turnIndex,
          outcome.status === "succeeded"
            ? { status: "succeeded", result: reply }
            : { status: "failed", error: outcome.error ?? "unknown error" },
        );
      }
      await this.options.githubReplyClient.postIssueComment(owner, repo, issueNumber, reply);
    };

    const tracked = await this.options.sessionPageStore?.addTurn(sessionId, request);
    const outcome = await invokeOnce();

    // Unauthenticated turn: `result` is a "link your account" prompt, not
    // finished work. Post the prompt, then -- for a provider whose token store
    // this gateway owns -- wait for the link to complete and resume the SAME
    // request automatically, so the user doesn't have to re-trigger the issue
    // by hand after linking. If the link isn't completed in time, the prompt
    // stands and a later re-trigger picks up where this left off.
    if (outcome.status === "succeeded" && outcome.identityLinkPending && outcome.identityLink) {
      await finishTurn(tracked, outcome);
      const resumed = await this.waitAndResume(outcome.identityLink, invokeOnce);
      if (resumed) await finishTurn(await this.options.sessionPageStore?.addTurn(sessionId, request), resumed);
      return;
    }

    await finishTurn(tracked, outcome);
  }

  /**
   * Waits for a pending identity link to complete, then re-runs the turn.
   * Only providers whose token store this gateway itself owns can be waited
   * on -- today, both `claude` (setup-token) and `claude-remote` (full
   * login, docs/adr/0027's follow-up), since both live in the same
   * `claudeAuthStore` (`ClaudeTokenStore`, keyed by `kind`). This used to
   * hardcode `identityLink.provider === "claude"` only, so a claude-remote
   * link prompt would post correctly but NEVER auto-resume -- the exact
   * "why didn't it start automatically after linking" gap this fixes.
   * Anything else -- e.g. a GitHub triage using the already-linked shared
   * identity -- returns `undefined` and the caller leaves the link prompt
   * standing for a manual re-trigger. Returns the resumed turn's outcome, or
   * `undefined` if the link never landed within the wait window.
   */
  private async waitAndResume(
    identityLink: { provider: string; subject: string },
    reinvoke: () => Promise<OrchestratorInvokeResult>,
  ): Promise<OrchestratorInvokeResult | undefined> {
    const kind = identityLink.provider === "claude" ? "setup-token" : identityLink.provider === "claude-remote" ? "login" : undefined;
    const store = kind ? this.options.claudeAuthStore : undefined;
    if (!store || !kind) return undefined;
    const record = await store.waitForCompletion(identityLink.subject, GatewayServer.RESUME_WAIT_MS, kind);
    if (!record) return undefined;
    return reinvoke();
  }

  private async handleSessionPage(res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    // Real-time liveness check (ADR 0026) -- refreshed on every page load
    // rather than trusted from a stale cache, since the underlying Pod could
    // have exited since the last check.
    const liveStatus = await this.options.orchestratorClient.checkLive(entry.sessionId);
    if (liveStatus.live && liveStatus.agentRunId) {
      if (entry.live?.agentRunId !== liveStatus.agentRunId) {
        await this.options.sessionPageStore!.setLive(entry.sessionId, { agentRunId: liveStatus.agentRunId });
        entry.live = { agentRunId: liveStatus.agentRunId };
      }
    } else if (entry.live) {
      await this.options.sessionPageStore!.setLive(entry.sessionId, undefined);
      entry.live = undefined;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderSessionPage(entry, { live: liveStatus.live }));
  }

  /**
   * `GET /sessions/:token/live-events` (ADR 0026): proxies
   * agent-orchestrator's `GET /agent-runs/:runId/events` SSE stream straight
   * through to the browser's `EventSource` -- piped, not buffered.
   */
  private async handleSessionLiveEvents(res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry?.live?.agentRunId) {
      res.writeHead(404).end("Not found");
      return;
    }
    const upstream = await this.options.orchestratorClient.openEventStream(entry.live.agentRunId, entry.sessionId);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502).end("Live session unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // Client disconnected or upstream dropped -- nothing to recover.
    } finally {
      res.end();
    }
  }

  /**
   * `POST /sessions/:token/live-prompt` (ADR 0026): submits a prompt
   * directly into the live opencode session (fire-and-forget via
   * `prompt_async` -- the response streams back through the SSE view the
   * caller is presumably already watching), discovering and caching the
   * underlying opencode session id on first use.
   */
  private async handleSessionLivePrompt(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry?.live?.agentRunId) {
      res.writeHead(404).end("Not found");
      return;
    }
    const rawBody = await readBody(req);
    const prompt = new URLSearchParams(rawBody).get("prompt")?.trim() ?? "";
    if (prompt) {
      this.submitLivePrompt(entry.sessionId, entry.live.agentRunId, entry.live.opencodeSessionId, prompt).catch(
        this.options.onBackgroundError ?? ((error: unknown) => console.error(error)),
      );
    }
    res.writeHead(303, { location: `/sessions/${token}` }).end();
  }

  private async submitLivePrompt(
    sessionId: string,
    agentRunId: string,
    opencodeSessionId: string | undefined,
    prompt: string,
  ): Promise<void> {
    let sessionIdToUse = opencodeSessionId;
    if (!sessionIdToUse) {
      const listed = await this.options.orchestratorClient.forwardOpencode(agentRunId, sessionId, {
        method: "GET",
        path: "/session",
      });
      const sessions = Array.isArray(listed.body) ? (listed.body as Array<{ id?: unknown }>) : [];
      const discovered = sessions.find((s) => typeof s.id === "string")?.id as string | undefined;
      if (!discovered) throw new Error("could not discover the live opencode session id");
      sessionIdToUse = discovered;
      await this.options.sessionPageStore!.setLive(sessionId, { agentRunId, opencodeSessionId: discovered });
    }
    await this.options.orchestratorClient.forwardOpencode(agentRunId, sessionId, {
      method: "POST",
      path: `/session/${sessionIdToUse}/prompt_async`,
      body: { parts: [{ type: "text", text: prompt }] },
    });
  }

  private async handleSessionPrompt(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    const rawBody = await readBody(req);
    const prompt = new URLSearchParams(rawBody).get("prompt")?.trim() ?? "";
    if (prompt) {
      this.runTurn(entry.owner, entry.repo, entry.issueNumber, entry.sessionId, prompt).catch(
        this.options.onBackgroundError ?? ((error: unknown) => console.error(error)),
      );
    }
    // Redirect back to the page immediately -- the new turn shows as
    // "pending" there (meta-refreshing) rather than blocking this response
    // on the orchestrator's full turn, same async posture as the webhook path.
    res.writeHead(303, { location: `/sessions/${token}` }).end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
