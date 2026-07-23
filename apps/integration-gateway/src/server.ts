import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { REPLY_MARKER, type GithubReplyClient } from "./github-client.js";
import type { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { IdentityLinkApi } from "./identity-link/api.js";
import type { IdentityResolver } from "./identity.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
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
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
