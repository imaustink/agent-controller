import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { REPLY_MARKER, type GithubReplyClient } from "./github-client.js";
import type { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { IdentityLinkApi } from "./identity-link/api.js";
import type { IdentityResolver } from "./identity.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { renderSessionPage, sessionViewerUrl, verifySessionToken } from "./session-viewer.js";
import { parseGithubEvent, verifyGithubSignature, WebhookAuthError } from "./webhooks/github.js";

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
   * Public base URL + HMAC secret for the session-viewer page
   * (`GET /sessions/:sessionId`, `POST /sessions/:sessionId/messages` --
   * see session-viewer.ts). Optional: absent -> the "starting work" comment
   * posted for a triage trigger omits the viewer link, and both routes
   * 404 -- existing deployments/tests that don't configure this keep
   * working exactly as before this feature existed.
   */
  sessionViewer?: { baseUrl: string; secret: string };
}

/** `owner/repo#issueNumber` scoped session id -- see docs/integrations-gateway.md's conversational path. */
export function sessionIdFor(owner: string, repo: string, issueNumber: number): string {
  return `github:${owner}/${repo}#${issueNumber}`;
}

/** Inverse of {@link sessionIdFor} -- `undefined` for any session id not produced by it (e.g. an Open WebUI chat id). */
export function parseGithubSessionId(
  sessionId: string,
): { owner: string; repo: string; issueNumber: number } | undefined {
  const match = /^github:([^/]+)\/([^#]+)#(\d+)$/.exec(sessionId);
  if (!match) return undefined;
  return { owner: match[1] as string, repo: match[2] as string, issueNumber: Number(match[3]) };
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

  constructor(private readonly options: GatewayServerOptions) {
    this.identityLinkApi =
      options.identityLinkLinker && options.identityLinkToken
        ? new IdentityLinkApi(options.identityLinkLinker, options.identityLinkToken)
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
    // The authcode callback route is intercepted BEFORE the bearer-gated
    // dispatch below -- it's hit directly by the end user's browser (via
    // GitHub's redirect), which cannot carry our internal bearer token, and
    // `identityLinkApi.handle`'s own bearer check would otherwise 401 it.
    if (this.identityLinkApi && (await this.identityLinkApi.handleCallback(req, res, url))) {
      return;
    }
    if (this.identityLinkApi && (await this.identityLinkApi.handle(req, res, url))) {
      return;
    }
    // Session-viewer page (see session-viewer.ts): only registered when
    // configured -- absent config, both fall through to the 404 below,
    // same as identity-link's own opt-in routes.
    if (this.options.sessionViewer) {
      // sessionId (e.g. "github:acme/widgets#7") may itself contain "/" --
      // the link this gateway posts percent-encodes it into a single path
      // segment, decoded here.
      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && sessionMatch) {
        await this.handleGetSessionPage(res, decodeURIComponent(sessionMatch[1] as string), url.searchParams.get("token"));
        return;
      }
      const sessionMessageMatch = /^\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
      if (req.method === "POST" && sessionMessageMatch) {
        await this.handlePostSessionMessage(
          req,
          res,
          decodeURIComponent(sessionMessageMatch[1] as string),
          url.searchParams.get("token"),
        );
        return;
      }
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

      this.startTriage(event.owner, event.repo, event.issueNumber, request, sessionId, {
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
    // This relay has no browser -- always force device flow explicitly
    // rather than relying on agent-orchestrator's own default (which is
    // "authcode", intended for browser-based callers). Only pass a 4th
    // argument when there's an event descriptor -- keeps the call shape
    // identical to before this feature existed for the ordinary
    // opened/comment paths.
    const outcome = event
      ? await this.options.orchestratorClient.invoke(request, sessionId, "device", event)
      : await this.options.orchestratorClient.invoke(request, sessionId, "device");
    const reply =
      outcome.status === "succeeded"
        ? (outcome.result ?? "")
        : `Something went wrong processing this: ${outcome.error ?? "unknown error"}`;
    await this.options.githubReplyClient.postIssueComment(owner, repo, issueNumber, reply);
  }

  /**
   * Entry point for the deterministic triage trigger (`issues.labeled`,
   * ADR 0024): posts an upfront acknowledgment comment (the task this
   * implements -- an agent shouldn't go silent while it works, potentially
   * for minutes, on a Job) BEFORE relaying the turn to agent-orchestrator,
   * then proceeds exactly as `relayAndReply` always has. A failure posting
   * the upfront comment (e.g. a transient GitHub API blip) is logged but
   * never blocks the actual triage work from starting.
   */
  private async startTriage(
    owner: string,
    repo: string,
    issueNumber: number,
    request: string,
    sessionId: string,
    event: Record<string, string | number | undefined>,
  ): Promise<void> {
    try {
      await this.postStartingWorkComment(owner, repo, issueNumber, sessionId);
    } catch (error) {
      (this.options.onBackgroundError ?? ((err: unknown) => console.error(err)))(error);
    }
    await this.relayAndReply(owner, repo, issueNumber, request, sessionId, event);
  }

  /**
   * Posts the "I'm on it" comment (see `startTriage`). When the session
   * viewer is configured (`options.sessionViewer`), the comment also links
   * to that session's live-ish viewer page (`session-viewer.ts`) -- where
   * the requester can watch the agent's transcript and, once it's ready to
   * work, send it additional instructions without waiting for a full
   * round-trip through GitHub. Omitted entirely when unconfigured; the
   * agent still asks questions/replies the existing way (a normal issue
   * comment via `relayAndReply`).
   */
  private async postStartingWorkComment(
    owner: string,
    repo: string,
    issueNumber: number,
    sessionId: string,
  ): Promise<void> {
    const lines = [
      "🤖 Thanks for the report — I'm starting to look into this now. I'll follow up here, either with a clarifying question or the result.",
    ];
    if (this.options.sessionViewer) {
      const url = sessionViewerUrl(this.options.sessionViewer.baseUrl, this.options.sessionViewer.secret, sessionId);
      lines.push(`You can watch my progress and send me additional instructions here: ${url}`);
    }
    await this.options.githubReplyClient.postIssueComment(owner, repo, issueNumber, lines.join("\n\n"));
  }

  /**
   * Renders the session-viewer page (`session-viewer.ts`) for a `?token=`
   * that must match `sessionId`'s HMAC capability token -- see
   * `session-viewer.ts`'s doc comment for why a signed token rather than a
   * stored one. `orchestratorClient.getSession` is a best-effort read
   * (never throws); an unknown/not-yet-created session renders an empty
   * transcript rather than a 404, since the viewer link is posted before
   * agent-orchestrator necessarily has a `SessionRecord` for it yet.
   */
  private async handleGetSessionPage(res: ServerResponse, sessionId: string, token: string | null): Promise<void> {
    if (!verifySessionToken(this.options.sessionViewer!.secret, sessionId, token)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("Invalid or missing token");
      return;
    }
    const view = await this.options.orchestratorClient.getSession(sessionId);
    const html = renderSessionPage(sessionId, token ?? "", view);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  }

  /**
   * Accepts an additional instruction typed into the session-viewer page
   * and relays it exactly as if the requester had left it as a new GitHub
   * issue comment -- reuses `relayAndReply` unchanged (including posting
   * its eventual result back onto the issue), so the viewer's textbox is
   * just another way to talk to the same conversation, not a parallel
   * channel. Fire-and-forget (same posture as the webhook handler): the
   * browser is redirected straight back to the viewer page rather than
   * held open for however long the turn takes.
   */
  private async handlePostSessionMessage(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    token: string | null,
  ): Promise<void> {
    if (!verifySessionToken(this.options.sessionViewer!.secret, sessionId, token)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("Invalid or missing token");
      return;
    }
    const parsedSession = parseGithubSessionId(sessionId);
    if (!parsedSession) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Not a GitHub-issue session");
      return;
    }
    const rawBody = await readBody(req);
    const text = extractMessageText(rawBody, req.headers["content-type"]);
    if (!text) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("A non-empty `text` field is required");
      return;
    }

    this.relayAndReply(parsedSession.owner, parsedSession.repo, parsedSession.issueNumber, text, sessionId).catch(
      this.options.onBackgroundError ?? ((error: unknown) => console.error(error)),
    );

    res
      .writeHead(303, { location: `/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token ?? "")}` })
      .end();
  }
}

/**
 * Pulls `text` out of the session-viewer message form, whether posted as a
 * plain HTML form (`application/x-www-form-urlencoded`, the default for
 * the page's own `<form>`) or as JSON (for a scripted caller). Returns
 * `undefined` for anything missing/blank rather than throwing -- the caller
 * turns that into a 400.
 */
function extractMessageText(rawBody: string, contentType: string | string[] | undefined): string | undefined {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (type?.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody) as { text?: unknown };
      return typeof parsed.text === "string" && parsed.text.trim() !== "" ? parsed.text.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  const text = new URLSearchParams(rawBody).get("text");
  return text && text.trim() !== "" ? text.trim() : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
