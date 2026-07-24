import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer } from "../identity-link/api.js";
import { renderClaudeAuthPage, renderClaudeAuthResultPage } from "./page.js";
import type { SubmitCodeResult } from "./pty-setup-token.js";
import type { ClaudeSetupTokenFlows } from "./pty-setup-token.js";
import type { ClaudeLoginFlows } from "./pty-login.js";
import type { ClaudeAuthKind, ClaudeTokenStore } from "./store.js";

/** Hard ceiling on `/claude-auth/api/wait`'s `timeoutMs`. */
const MAX_WAIT_MS = 10 * 60 * 1000;

const PAGE_PATH = /^\/claude-auth\/([^/]+)$/;
const SUBMIT_PATH = /^\/claude-auth\/([^/]+)\/submit$/;

/**
 * Structural shape shared by `ClaudeSetupTokenFlows` and `ClaudeLoginFlows` --
 * deliberately NOT a common base class/explicit `implements` on either (see
 * `pty-login.ts`'s file header on why the two stay parallel, near-duplicate
 * files rather than a shared abstraction); this interface exists only so
 * `ClaudeAuthApi` can hold one reference and dispatch on `mode` without an
 * `if/else` duplicating every method call below.
 */
interface ClaudeAuthFlows {
  start(subject: string): Promise<{ flowId: string; authorizeUrl: string }>;
  getSubject(flowId: string): string | undefined;
  submitCode(flowId: string, code: string): Promise<SubmitCodeResult>;
}

/** Request-level mode selector -- defaults to `"setup-token"` everywhere it's read, so every existing caller that never mentions `mode` gets today's exact behavior unchanged. */
type ClaudeAuthMode = "setup-token" | "login";

function normalizeMode(raw: unknown): ClaudeAuthMode {
  return raw === "login" ? "login" : "setup-token";
}

function kindForMode(mode: ClaudeAuthMode): ClaudeAuthKind {
  return mode === "login" ? "login" : "setup-token";
}

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
    /**
     * Full-login (`claude auth login --claudeai`) flows for Remote Control
     * (docs/adr/0027 follow-up) -- optional and additive so every existing
     * construction site (which only ever knew about `setup-token`) keeps
     * compiling and behaving unchanged. `mode=login` is a hard 501 wherever
     * this is left undefined, never a silent fallback to `setup-token`.
     */
    private readonly loginFlows?: ClaudeLoginFlows,
  ) {}

  /** Picks the flows engine for `mode`, or `undefined` if that mode isn't wired up (e.g. `login` before `loginFlows` is configured). */
  private flowsFor(mode: ClaudeAuthMode): ClaudeAuthFlows | undefined {
    return mode === "login" ? this.loginFlows : this.flows;
  }

  async handlePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const pageMatch = req.method === "GET" ? PAGE_PATH.exec(url.pathname) : null;
    if (pageMatch) {
      const flowId = pageMatch[1]!;
      const mode = normalizeMode(url.searchParams.get("mode"));
      const flows = this.flowsFor(mode);
      const subject = flows?.getSubject(flowId);
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
      const submitAction = mode === "login" ? `/claude-auth/${flowId}/submit?mode=login` : `/claude-auth/${flowId}/submit`;
      sendHtml(res, 200, renderClaudeAuthPage({ authorizeUrl, submitAction }));
      return true;
    }

    const submitMatch = req.method === "POST" ? SUBMIT_PATH.exec(url.pathname) : null;
    if (submitMatch) {
      const flowId = submitMatch[1]!;
      const mode = normalizeMode(url.searchParams.get("mode"));
      const flows = this.flowsFor(mode);
      const subject = flows?.getSubject(flowId);
      const rawBody = await readBody(req);
      const code = new URLSearchParams(rawBody).get("code")?.trim() ?? "";
      if (!flows || !subject || !code) {
        sendHtml(res, 400, renderClaudeAuthResultPage({ success: false, message: "This authorization link has expired, or no code was submitted." }));
        return true;
      }
      const result = await flows.submitCode(flowId, code);
      if (result.status === "error") {
        // A 400 from the token exchange (now that code truncation is fixed)
        // almost always means the authorization code was expired, already
        // used, or generated from an older link -- guide the user toward a
        // clean single attempt instead of leaving them to guess.
        const hint = /status code 400/.test(result.message)
          ? " This usually means the code expired, was already used, or came from an older link. Start the link again from chat and complete it in one go without reusing a previous code."
          : "";
        sendHtml(res, 200, renderClaudeAuthResultPage({ success: false, message: result.message + hint }));
        return true;
      }
      const kind = kindForMode(mode);
      const record = kind === "login" ? { kind, credentialsJson: result.token, createdAt: new Date().toISOString() } : { kind, token: result.token, createdAt: new Date().toISOString() };
      await this.store.set(subject, record);
      sendHtml(res, 200, renderClaudeAuthResultPage({ success: true, message: mode === "login" ? "Your Claude account is now linked (full login)." : "Your Claude account is now linked." }));
      return true;
    }

    return false;
  }

  /** Builds the page URL to hand back from `start`, embedding the authorize URL (and, for non-default modes, `mode`) so `handlePage`'s GET doesn't need to re-derive either. */
  private buildPageUrl(flowId: string, authorizeUrl: string, mode: ClaudeAuthMode): string {
    const url = new URL(`/claude-auth/${flowId}`, this.publicBaseUrl);
    url.searchParams.set("u", authorizeUrl);
    // Only appended for non-default modes -- keeps the URL shape byte-for-byte
    // identical to before `mode` existed for every existing `setup-token` caller.
    if (mode !== "setup-token") url.searchParams.set("mode", mode);
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
    const { subject } = body as { subject: string; mode?: unknown };
    const mode = normalizeMode((body as { mode?: unknown }).mode);
    await this.store.delete(subject, kindForMode(mode));
    sendJson(res, 200, { status: "ok" });
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    const mode = normalizeMode((body as { mode?: unknown }).mode);
    const flows = this.flowsFor(mode);
    if (!flows) {
      sendJson(res, 501, { error: `claude-auth mode "${mode}" is not configured on this gateway` });
      return;
    }
    try {
      const { flowId, authorizeUrl } = await flows.start(subject);
      sendJson(res, 200, { flowId, pageUrl: this.buildPageUrl(flowId, authorizeUrl, mode) });
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
    const mode = normalizeMode((body as { mode?: unknown }).mode);
    const rawTimeout = (body as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof rawTimeout === "number" && rawTimeout > 0 ? Math.min(rawTimeout, MAX_WAIT_MS) : MAX_WAIT_MS;

    const record = await this.store.waitForCompletion(subject, timeoutMs, kindForMode(mode));
    if (!record) {
      sendJson(res, 200, { status: "timeout" });
      return;
    }
    sendJson(res, 200, mode === "login" ? { status: "complete", credentialsJson: record.credentialsJson } : { status: "complete", token: record.token });
  }

  private async handleToken(res: ServerResponse, url: URL): Promise<void> {
    const subject = url.searchParams.get("subject");
    if (!subject) {
      sendJson(res, 400, { error: "Query parameter `subject` is required" });
      return;
    }
    const mode = normalizeMode(url.searchParams.get("mode"));
    const record = await this.store.get(subject, kindForMode(mode));
    if (!record) {
      res.writeHead(404).end();
      return;
    }
    sendJson(res, 200, mode === "login" ? { credentialsJson: record.credentialsJson } : { token: record.token });
  }
}
