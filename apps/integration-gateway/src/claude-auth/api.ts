import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer } from "../identity-link/api.js";
import { renderClaudeAuthPage, renderClaudeAuthResultPage } from "./page.js";
import type { SubmitCodeResult } from "./pty-setup-token.js";
import type { ClaudeSetupTokenFlows } from "./pty-setup-token.js";
import type { ClaudeLoginFlows } from "./pty-login.js";
import type { ClaudeAuthKind, ClaudeTokenStore } from "./store.js";

/** Hard ceiling on `/claude-auth/api/wait`'s `timeoutMs`. */
const MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Lifetime of a credential write-back grant when the caller doesn't ask for
 * one. A grant only has to outlive the AgentRun it was minted for (the CLI
 * refreshes at some unpredictable point during the turn), so the default
 * matches the generous end of a long coding run rather than a chat turn.
 */
const DEFAULT_WRITEBACK_TTL_SECONDS = 60 * 60;

/** Ceiling on a requested grant lifetime -- a grant that outlives its run is just a spare key lying around. */
const MAX_WRITEBACK_TTL_SECONDS = 6 * 60 * 60;

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

    // Dispatched BEFORE the master-bearer gate: this is the one route an
    // individual AgentRun calls, and it authenticates with the narrow,
    // expiring write-back grant `handleWritebackToken` minted for that run's
    // subject -- never with `this.bearerToken` (which could read and mint
    // credentials for every subject and therefore never enters a run's
    // environment). `handleRefresh` itself 401s on a bad grant.
    if (req.method === "POST" && action === "refresh") {
      await this.handleRefresh(req, res);
      return true;
    }

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
    if (req.method === "POST" && action === "rekey") {
      await this.handleRekey(req, res);
      return true;
    }
    if (req.method === "POST" && action === "writeback-token") {
      await this.handleWritebackToken(req, res);
      return true;
    }
    res.writeHead(404).end();
    return true;
  }

  /**
   * Mints a write-back grant for one subject (bearer-gated -- called by
   * agent-orchestrator at AgentRun launch time, never by a run itself). See
   * `ClaudeTokenStore.createWritebackToken` for why this is a separate,
   * narrowly-scoped token rather than the gateway bearer.
   */
  private async handleWritebackToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    const rawTtl = (body as { ttlSeconds?: unknown }).ttlSeconds;
    const ttlSeconds =
      typeof rawTtl === "number" && rawTtl > 0 ? Math.min(rawTtl, MAX_WRITEBACK_TTL_SECONDS) : DEFAULT_WRITEBACK_TTL_SECONDS;
    try {
      const { token, secretName } = await this.store.createWritebackToken(subject, ttlSeconds);
      sendJson(res, 200, {
        token,
        url: new URL("/claude-auth/api/refresh", this.publicBaseUrl).toString(),
        ttlSeconds,
        // The object backing this grant, so the orchestrator can make the
        // AgentRun it is minting for the grant's OWNER -- Kubernetes then
        // reclaims it with the run (docs/adr/0034). Informational: a caller that
        // ignores it still gets a working grant, just one that lingers as an
        // object until it is swept, having already stopped authorizing anything
        // at `expiresAt`.
        secretName,
      });
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Persists a `credentialsJson` blob that a run's own Claude Code CLI
   * refreshed in-pod, replacing the stored `login` record for the subject the
   * presented grant token was minted for.
   *
   * Why this route has to exist: the stored blob is copied into each run's
   * ephemeral HOME (an emptyDir), the CLI refreshes its access token there,
   * and Anthropic ROTATES the refresh token when it does -- so the copy left
   * in Redis is dead as soon as the first run refreshes, and every later run
   * fails with "Login expired · Please run /login" even though the human
   * linked their account only hours earlier. Writing the refreshed blob back
   * is what makes the link survive.
   *
   * The subject comes from the grant token, NEVER from the request body: a
   * run can only ever overwrite its own subject's credential, so a leaked or
   * misused grant can't clobber someone else's link.
   */
  private async handleRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
    const subject = presented ? await this.store.resolveWritebackToken(presented) : undefined;
    if (!subject) {
      res.writeHead(401).end();
      return;
    }
    const body = await parseJsonBody(req);
    const credentialsJson = (body as { credentialsJson?: unknown } | undefined)?.credentialsJson;
    if (typeof credentialsJson !== "string" || !credentialsJson.trim()) {
      sendJson(res, 400, { error: "Request body must be JSON with a non-empty string `credentialsJson` field" });
      return;
    }
    try {
      // Reject anything that isn't a credentials FILE. Without this a run
      // could replace a working link with junk it happened to read, and the
      // damage would only show up on the next run as a fresh re-link prompt.
      JSON.parse(credentialsJson);
    } catch {
      sendJson(res, 400, { error: "`credentialsJson` must be the JSON contents of a ~/.claude/.credentials.json file" });
      return;
    }
    await this.store.set(subject, { kind: "login", credentialsJson, createdAt: new Date().toISOString() });
    // `ClaudeTokenStore.set` swallows its own Redis errors (by design -- a
    // failed link write must not crash a login page), which would make a
    // silently-dropped refresh indistinguishable from a stored one and put us
    // right back at the stale-credential failure this route exists to fix.
    // Read back and say so explicitly instead.
    const stored = await this.store.get(subject, "login");
    if (stored?.credentialsJson !== credentialsJson) {
      sendJson(res, 502, { error: "The refreshed credentials could not be persisted" });
      return;
    }
    sendJson(res, 200, { status: "ok" });
  }

  /**
   * Moves one subject's stored credential to another subject (bearer-gated --
   * called by agent-orchestrator's authorization pre-flight, never by a run).
   *
   * Why the gateway exposes this at all: agent-orchestrator changed which
   * subject it keys these records by, from the entry point's own subject to the
   * caller's principal (docs/adr/0029, 0031). Both flows now READ the same key;
   * this is what makes the credential a human already authorized actually BE at
   * that key, instead of every existing user paying a fresh login to reproduce
   * a credential the gateway is already holding.
   *
   * ## Who is allowed to ask
   *
   * The orchestrator, and only because it is the component that established
   * both subjects belong to the same human -- `from` is the authenticated
   * caller's own subject for the turn, and `to` is the principal derived from a
   * GitHub account that same caller proved control of. This route cannot
   * re-derive that, so it does not pretend to: it is gated on the master bearer
   * token, exactly like `token` (which already hands out any subject's
   * credential) and `invalidate` (which already destroys any subject's). It
   * grants no authority over the keyspace that those two do not.
   *
   * What it will NOT do is overwrite a record at the destination, so a stale
   * source can never displace a current credential.
   */
  private async handleRekey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseJsonBody(req);
    const from = (body as { from?: unknown } | undefined)?.from;
    const to = (body as { to?: unknown } | undefined)?.to;
    if (typeof from !== "string" || !from.trim() || typeof to !== "string" || !to.trim()) {
      sendJson(res, 400, { error: "Request body must be JSON with non-empty string `from` and `to` fields" });
      return;
    }
    const mode = normalizeMode((body as { mode?: unknown }).mode);
    try {
      const status = await this.store.rekey(from, to, kindForMode(mode));
      sendJson(res, 200, { status });
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
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
