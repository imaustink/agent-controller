import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { REPLY_MARKER, type GithubReplyClient } from "./github-client.js";
import type { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { IdentityLinkApi } from "./identity-link/api.js";
import { ClaudeAuthApi } from "./claude-auth/api.js";
import type { ClaudeSetupTokenFlows } from "./claude-auth/pty-setup-token.js";
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
   * Session-page feature (issue #81) -- both fields must be set together to
   * enable it: a "starting work" comment posted right when an
   * `issues.labeled` triage trigger fires (rather than only after the whole
   * turn completes), linking to a minimal `GET /sessions/:token` page that
   * shows that session's turn history and lets a caller `POST` it follow-up
   * prompts. Omitted entirely (leaving both undefined) preserves this
   * gateway's exact pre-#81 behavior -- no page routes are reachable, and
   * plain conversational (non-labeled) relays are completely unaffected
   * either way.
   */
  sessionPageStore?: SessionPageStore;
  publicBaseUrl?: string;
}

/** `owner/repo#issueNumber` scoped session id -- see docs/integrations-gateway.md's conversational path. */
export function sessionIdFor(owner: string, repo: string, issueNumber: number): string {
  return `github:${owner}/${repo}#${issueNumber}`;
}

/**
 * Consumer-facing HTTP surface for the GitHub Issues adapter: verifies each
 * webhook, maps it onto a per-issue orchestrator session, and relays the
 * eventual result back as an issue comment. See docs/integrations-gateway.md
 * -- this implements only the conversational path (no `target`/FAAS
 * shortcut): every event goes through agent-orchestrator's existing RAG
 * skill retrieval, which already owns deciding whether to ask a clarifying
 * question or delegate to the SWE agent.
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
        ? new ClaudeAuthApi(options.claudeAuthFlows, options.claudeAuthStore, options.identityLinkToken, options.publicBaseUrl)
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

    // An issue created WITH the trigger label already attached fires a
    // SEPARATE `issues.labeled` webhook delivery a moment after `opened`
    // (one per label present at creation) -- skip relaying `opened` here so
    // that guaranteed-to-follow `labeled` event is the only one that
    // dispatches. Without this, both events independently delegate the same
    // session to the same agent, racing each other into two AgentRuns.
    if (event.kind === "issue-opened" && this.options.githubTriggerLabel && event.labelNames.includes(this.options.githubTriggerLabel)) {
      return;
    }

    // Belt-and-suspenders loop guard: skip our own bot/replies even if a
    // login isn't flagged as `type: "Bot"` (e.g. a PAT-backed account).
    const text = event.kind === "issue-opened" ? event.body : event.commentBody;
    if (text.includes(REPLY_MARKER)) return;

    const identity = await this.options.identityResolver.resolve(event.senderLogin, event.senderIsBot, {
      owner: event.owner,
      repo: event.repo,
    });
    if (!identity) return;

    const sessionId = sessionIdFor(event.owner, event.repo, event.issueNumber);
    const request = event.kind === "issue-opened" ? `${event.title}\n\n${event.body}`.trim() : event.commentBody;

    this.relayAndReply(event.owner, event.repo, event.issueNumber, request, sessionId).catch(
      this.options.onBackgroundError ?? ((error: unknown) => console.error(error)),
    );
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
    // session page and an upfront "starting work" comment (issue #81); the
    // `event` descriptor is only ever set on that path (see
    // `handleGithubWebhook`'s issue-labeled branch), which doubles as the
    // discriminator here. Ordinary conversational opened/comment replies are
    // meant to feel like near-instant chat, so an extra comment there would
    // just be noise -- and they're unaffected either way if the feature is
    // disabled (`sessionPageStore`/`publicBaseUrl` unset).
    if (event && this.options.sessionPageStore && this.options.publicBaseUrl) {
      const page = await this.options.sessionPageStore.getOrCreate(sessionId, { owner, repo, issueNumber });
      const pageUrl = `${this.options.publicBaseUrl.replace(/\/$/, "")}/sessions/${page.token}`;
      await this.options.githubReplyClient.postIssueComment(
        owner,
        repo,
        issueNumber,
        `Starting work on this now. Track progress or send follow-up prompts at ${pageUrl}`,
      );
    }
    await this.runTurn(owner, repo, issueNumber, sessionId, request, event);
  }

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
  ): Promise<void> {
    const tracked = await this.options.sessionPageStore?.addTurn(sessionId, request);

    // This relay has no browser -- always force device flow explicitly
    // rather than relying on agent-orchestrator's own default (which is
    // "authcode", intended for browser-based callers). Only pass a 4th
    // argument when there's an event descriptor -- keeps the call shape
    // identical to before this feature existed for the ordinary
    // opened/comment paths.
    const outcome: OrchestratorInvokeResult = event
      ? await this.options.orchestratorClient.invoke(request, sessionId, "device", event)
      : await this.options.orchestratorClient.invoke(request, sessionId, "device");
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
