import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer } from "../identity-link/api.js";
import { renderClaudeAuthPage, renderClaudeAuthResultPage } from "./page.js";
import type { ClaudeSetupTokenFlows } from "./pty-setup-token.js";
import type { ClaudeTokenStore } from "./store.js";

/** Hard ceiling on `/claude-auth/api/wait`'s `timeoutMs`. */
const MAX_WAIT_MS = 10 * 60 * 1000;

const PAGE_PATH = /^\/claude-auth\/([^/]+)$/;
const SUBMIT_PATH = /^\/claude-auth\/([^/]+)\/submit$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(html);
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Two-layer API for the per-user Claude Code OAuth `setup-token` flow
 * (docs/adr/0027):
 *
 * - **Internal, bearer-gated** (`handle`): agent-orchestrator calls
 *   `/claude-auth/api/{start,wait,token}`, mirroring `identity-link/api.ts`'s
 *   shape for the GitHub device flow (the `/api/` segment keeps this
 *   disjoint from the browser-facing routes below -- see `handle`'s doc).
 * - **Browser-facing, capability-gated by `flowId`** (`handlePage`): the
 *   human visits the link the orchestrator's reply gave them, sees the
 *   authorize link, and pastes the resulting code into a plain HTML form --
 *   same "the URL itself is the authorization, no bearer token" posture as
 *   `session-page.ts`. Must be dispatched BEFORE `handle`'s bearer check,
 *   same ordering requirement as identity-link's own OAuth callback route.
 */
export class ClaudeAuthApi {
  constructor(
    private readonly flows: ClaudeSetupTokenFlows,
    private readonly store: ClaudeTokenStore,
    private readonly bearerToken: string,
    private readonly publicBaseUrl: string,
  ) {}

  async handlePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const pageMatch = req.method === "GET" ? PAGE_PATH.exec(url.pathname) : null;
    if (pageMatch) {
      const flowId = pageMatch[1]!;
      const subject = this.flows.getSubject(flowId);
      if (!subject) {
        sendHtml(res, 404, renderClaudeAuthResultPage({ success: false, message: "This authorization link has expired or was already used." }));
        return true;
      }
      // The authorize URL was already captured at `start()` time; re-derive
      // it here would require re-parsing PTY output, so instead this route
      // simply re-renders the page shell -- the link text itself is static
      // once known, so the caller passes it via a query param set when the
      // link was first built (see `buildPageUrl`).
      const authorizeUrl = url.searchParams.get("u") ?? "";
      sendHtml(res, 200, renderClaudeAuthPage({ authorizeUrl, submitAction: `/claude-auth/${flowId}/submit` }));
      return true;
    }

    const submitMatch = req.method === "POST" ? SUBMIT_PATH.exec(url.pathname) : null;
    if (submitMatch) {
      const flowId = submitMatch[1]!;
      const subject = this.flows.getSubject(flowId);
      const rawBody = await readBody(req);
      const code = new URLSearchParams(rawBody).get("code")?.trim() ?? "";
      if (!subject || !code) {
        sendHtml(res, 400, renderClaudeAuthResultPage({ success: false, message: "This authorization link has expired, or no code was submitted." }));
        return true;
      }
      // Diagnostic (docs/adr/0027 follow-up): a real code was reaching the
      // token exchange but getting a 400 from Anthropic, indistinguishable in
      // the error text from an invalid code. Log only the code's LENGTH and
      // whether it has the `#state` half -- never any of its characters,
      // since it's a live one-time credential -- which is enough to confirm
      // the truncation fix (the full length now arrives at this layer).
      console.error(`[claude-auth] submit received for flow ${flowId}: len=${code.length} hasHash=${code.includes("#")}`);
      const result = await this.flows.submitCode(flowId, code);
      if (result.status === "error") {
        sendHtml(res, 200, renderClaudeAuthResultPage({ success: false, message: result.message }));
        return true;
      }
      await this.store.set(subject, { token: result.token, createdAt: new Date().toISOString() });
      sendHtml(res, 200, renderClaudeAuthResultPage({ success: true, message: "Your Claude account is now linked." }));
      return true;
    }

    return false;
  }

  /** Builds the page URL to hand back from `start`, embedding the authorize URL so `handlePage`'s GET doesn't need to re-derive it. */
  private buildPageUrl(flowId: string, authorizeUrl: string): string {
    const url = new URL(`/claude-auth/${flowId}`, this.publicBaseUrl);
    url.searchParams.set("u", authorizeUrl);
    return url.toString();
  }

  /**
   * Internal routes live under `/claude-auth/api/...` (3 segments), a
   * distinct shape from the browser-facing `/claude-auth/:flowId`(/submit)
   * routes `handlePage` matches (2-3 segments where the 2nd is a
   * caller-generated UUID, never the literal `api`) -- this prevents `GET
   * /claude-auth/api/token` (bearer-gated) from ever colliding with `GET
   * /claude-auth/:flowId` (capability-gated, no bearer token involved).
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "claude-auth" || segments[1] !== "api" || segments.length !== 3) return false;
    const action = segments[2]!;

    if (!checkBearer(req, this.bearerToken)) {
      res.writeHead(401).end();
      return true;
    }

    if (req.method === "POST" && action === "start") {
      await this.handleStart(req, res);
      return true;
    }
    if (req.method === "POST" && action === "wait") {
      await this.handleWait(req, res);
      return true;
    }
    if (req.method === "GET" && action === "token") {
      await this.handleToken(res, url);
      return true;
    }
    if (req.method === "POST" && action === "invalidate") {
      await this.handleInvalidate(req, res);
      return true;
    }
    res.writeHead(404).end();
    return true;
  }

  private async handleInvalidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    await this.store.delete(subject);
    sendJson(res, 200, { status: "ok" });
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    try {
      const { flowId, authorizeUrl } = await this.flows.start(subject);
      sendJson(res, 200, { flowId, pageUrl: this.buildPageUrl(flowId, authorizeUrl) });
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleWait(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    const rawTimeout = (body as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof rawTimeout === "number" && rawTimeout > 0 ? Math.min(rawTimeout, MAX_WAIT_MS) : MAX_WAIT_MS;

    const record = await this.store.waitForCompletion(subject, timeoutMs);
    if (!record) {
      sendJson(res, 200, { status: "timeout" });
      return;
    }
    sendJson(res, 200, { status: "complete", token: record.token });
  }

  private async handleToken(res: ServerResponse, url: URL): Promise<void> {
    const subject = url.searchParams.get("subject");
    if (!subject) {
      sendJson(res, 400, { error: "Query parameter `subject` is required" });
      return;
    }
    const record = await this.store.get(subject);
    if (!record) {
      res.writeHead(404).end();
      return;
    }
    sendJson(res, 200, { token: record.token });
  }
}
