import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer } from "../identity-link/api.js";
import type { OidcLoginClient, PendingLogin } from "./oidc-login.js";
import { renderConnectionsPage, renderMessagePage, type ConnectionRow } from "./page.js";
import type { PrincipalDirectory } from "./principal-directory.js";
import type { ConnectionProvider, ConnectionStatus } from "./providers.js";
import { signToken, verifyToken } from "./signed-token.js";

/**
 * The Connections page (docs/adr/0046): one place a person sees, links,
 * relinks and removes the accounts agents act as -- instead of meeting each
 * one as a bare link in the middle of a chat answer.
 *
 * Who you are comes from a real sign-in against the deployment's OIDC
 * provider, not a capability URL, so the page can be bookmarked and opened
 * cold. The verified email from that sign-in is mapped to the chat subject
 * every credential is stored under through {@link PrincipalDirectory}.
 *
 * Browser state is two signed cookies, so the gateway stays stateless across
 * replicas: `cx_session` (who is signed in) and, during a link, `cx_return`
 * (so the provider's callback can bring the user back here instead of
 * stranding them on a "you can close this tab" page).
 */

const SESSION_COOKIE = "cx_session";
const LOGIN_COOKIE = "cx_login";
const RETURN_COOKIE = "cx_return";
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** Matches the identity-link `state` lifetime: a link that outlives it fails anyway. */
const RETURN_TTL_MS = 10 * 60 * 1000;
const PROVIDER_ID = /^[a-z0-9-]{1,40}$/;
/**
 * Signs the `cx_return` cookie between two steps of a one-click chain. A
 * different purpose from a provider's return token, so neither can stand in
 * for the other.
 */
const CHAIN_PURPOSE = "cx_chain";

/** A one-click link in progress: what chat asked for, and what this chain already sent the user through. */
interface Chain {
  need: string[];
  attempted: string[];
}

function readChain(payload: Record<string, unknown> | undefined): Chain | undefined {
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  if (!payload || !strings(payload.chainNeed) || !strings(payload.attempted)) return undefined;
  return { need: payload.chainNeed, attempted: payload.attempted };
}

/**
 * The order a chain links providers in. GitHub first, because Claude's
 * credentials are filed under the principal a GitHub link establishes
 * (docs/adr/0031). The redirect-based providers next. Claude and then Remote
 * Control last: theirs are paste-the-code pages rather than a consent screen
 * that bounces straight back, so they are where a user is most likely to stop.
 */
function chainOrder(ids: string[]): string[] {
  const rank = (id: string) => (id === "github" ? 0 : id === "claude" ? 2 : id === "claude-remote" ? 3 : 1);
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

export interface ConnectionsApiOptions {
  providers: ConnectionProvider[];
  directory: PrincipalDirectory;
  oidc: OidcLoginClient;
  /** Signs this page's cookies. Derived, not configured -- see `deriveKey`. */
  cookieKey: Buffer;
  /** Bearer for the orchestrator-only principal route; the identity-link token. */
  internalToken: string;
  /** Public base URL, e.g. `https://gateway.example.com`. Decides the cookies' `Secure` flag. */
  publicBaseUrl: string;
  sessionTtlMs: number;
  now?: () => number;
}

interface Session {
  email: string;
  csrf: string;
}

export class ConnectionsApi {
  private readonly providers: Map<string, ConnectionProvider>;
  private readonly secure: boolean;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionsApiOptions) {
    this.providers = new Map(options.providers.map((p) => [p.id, p]));
    this.secure = options.publicBaseUrl.startsWith("https://");
    this.now = options.now ?? Date.now;
  }

  /** Handles any `/connections` route. Returns `false` when the path is not this API's. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "connections") return false;

    if (segments[1] === "api") {
      if (req.method === "PUT" && segments[2] === "principals" && segments.length === 3) {
        await this.handleRecordPrincipal(req, res);
      } else {
        res.writeHead(404).end();
      }
      return true;
    }

    if (req.method === "GET" && segments.length === 1) await this.handlePage(req, res, url);
    else if (req.method === "GET" && segments[1] === "link" && segments.length === 2) await this.handleLink(req, res, url);
    else if (req.method === "GET" && segments[1] === "link" && segments[2] === "next" && segments.length === 3) {
      await this.handleLinkNext(req, res, url);
    }
    else if (req.method === "GET" && segments[1] === "login" && segments.length === 2) await this.handleLogin(res, url);
    else if (req.method === "GET" && segments[1] === "callback" && segments.length === 2) await this.handleCallback(req, res, url);
    else if (req.method === "POST" && segments[1] === "logout" && segments.length === 2) await this.handleLogout(req, res);
    else if (req.method === "POST" && segments.length === 3 && segments[2] === "connect") await this.handleConnect(req, res, segments[1]!);
    else if (req.method === "POST" && segments.length === 3 && segments[2] === "disconnect") await this.handleDisconnect(req, res, segments[1]!);
    else res.writeHead(404).end();
    return true;
  }

  /**
   * Where a provider's OAuth callback should send the browser once a link
   * completes, if this page started that link -- otherwise `undefined`, and
   * the caller shows its own result page as before (a link started from a
   * chat prompt has no page to come back to).
   *
   * Consumes the return cookie, so a later link started from chat is not
   * redirected here by a stale one.
   */
  completionRedirect(req: IncomingMessage, res: ServerResponse, provider: string): string | undefined {
    const payload = this.takeReturn(req, res, provider);
    if (!payload) return undefined;
    // Mid-way through a one-click chain: on to the next provider, carrying the
    // chain forward in a fresh signed cookie rather than in the URL.
    const chain = readChain(payload);
    if (chain) {
      const token = signToken({ chainNeed: chain.need, attempted: chain.attempted }, CHAIN_PURPOSE, this.options.cookieKey, this.now() + RETURN_TTL_MS);
      res.appendHeader("set-cookie", this.cookie(RETURN_COOKIE, token, { path: "/", maxAgeSeconds: RETURN_TTL_MS / 1000 }));
      return "/connections/link/next";
    }
    const target = new URLSearchParams({ connected: provider });
    if (typeof payload.need === "string" && payload.need) target.set("need", payload.need);
    return `/connections?${target}`;
  }

  /**
   * Where a provider's callback should send the browser when the user DECLINED
   * a link this page started: back to the page, which still highlights what
   * chat needs. A one-click chain stops here -- the user said no, so moving on
   * to the next provider's consent would be the wrong answer. Whatever the
   * chain already connected stays connected.
   */
  cancelRedirect(req: IncomingMessage, res: ServerResponse, provider: string): string | undefined {
    const payload = this.takeReturn(req, res, provider);
    if (!payload) return undefined;
    const need = readChain(payload)?.need.join(",") ?? (typeof payload.need === "string" ? payload.need : "");
    const target = new URLSearchParams({ cancelled: provider });
    if (need) target.set("need", need);
    return `/connections?${target}`;
  }

  /** Consumes the return cookie; its payload only if it was issued for `provider`. */
  private takeReturn(req: IncomingMessage, res: ServerResponse, provider: string): Record<string, unknown> | undefined {
    const raw = readCookie(req, RETURN_COOKIE);
    if (!raw) return undefined;
    res.appendHeader("set-cookie", this.cookie(RETURN_COOKIE, "", { path: "/", maxAgeSeconds: 0 }));
    const payload = verifyToken(raw, RETURN_COOKIE, this.options.cookieKey, this.now());
    if (!payload || payload.provider !== provider) return undefined;
    return payload;
  }

  // ---- internal ---------------------------------------------------------

  /**
   * Records which chat subject an email belongs to. Called by
   * agent-orchestrator after it verifies Open WebUI's signed per-user JWT,
   * which carries both -- so this mapping is only ever as good as that
   * signature, and never comes from the browser.
   */
  private async handleRecordPrincipal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkBearer(req, this.options.internalToken)) {
      res.writeHead(401).end();
      return;
    }
    let body: { email?: unknown; subject?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      body = {};
    }
    if (typeof body.email !== "string" || !body.email.includes("@") || typeof body.subject !== "string" || !body.subject) {
      sendJson(res, 400, { error: "Body must be JSON with string `email` and `subject` fields" });
      return;
    }
    await this.options.directory.record(body.email, body.subject);
    res.writeHead(204).end();
  }

  // ---- browser routes ----------------------------------------------------

  private async handlePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const session = this.session(req);
    if (!session) {
      redirect(res, `/connections/login?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`);
      return;
    }
    const subject = await this.options.directory.lookup(session.email);
    if (!subject) {
      this.sendUnknownSubject(res, session, url);
      return;
    }

    const rows: ConnectionRow[] = await Promise.all(
      [...this.providers.values()].map(async (provider) => ({
        provider,
        status: await this.statusOf(provider, subject),
      })),
    );
    const needed = this.knownProviders(url.searchParams.get("need"));
    this.sendPage(
      res,
      200,
      renderConnectionsPage({
        email: session.email,
        rows,
        needed,
        csrf: session.csrf,
        ...this.flashFor(url),
      }),
    );
  }

  private flashFor(url: URL): { flash?: { kind: "ok" | "error"; message: string } } {
    const label = (id: string | null) => (id ? this.providers.get(id)?.label : undefined);
    const connected = label(url.searchParams.get("connected"));
    if (connected) return { flash: { kind: "ok", message: `${connected} is connected.` } };
    const disconnected = label(url.searchParams.get("disconnected"));
    if (disconnected) return { flash: { kind: "ok", message: `${disconnected} is disconnected.` } };
    const cancelled = label(url.searchParams.get("cancelled"));
    if (cancelled) return { flash: { kind: "error", message: `${cancelled} wasn't connected, because the request was declined.` } };
    const blocked = label(url.searchParams.get("blocked"));
    if (blocked) return { flash: { kind: "error", message: `${blocked} can't be connected yet. Connect GitHub first.` } };
    if (url.searchParams.get("error")) {
      return { flash: { kind: "error", message: "Something went wrong. Please try again." } };
    }
    return {};
  }

  /**
   * `GET /connections/link?need=a,b`: the one link a chat prompt carries. It
   * connects everything `need` names that isn't connected yet, one provider
   * after another, without stopping on this page in between.
   *
   * Sign-in goes through the ordinary login with `next` pointing back here, so
   * a user with a live IdP session never sees it. Then each step re-reads
   * status, skips what is connected, and redirects straight to the next
   * provider's own consent; its callback brings the browser back through
   * `/connections/link/next`.
   *
   * A GET that starts a link is safe here because it can only ever act for
   * the signed-in user's OWN subject, and the provider still asks that user
   * for consent: a forged navigation can at worst show someone a consent
   * screen for their own account. Nothing is disconnected, and the POST
   * routes keep their CSRF token.
   */
  private async handleLink(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const session = this.session(req);
    if (!session) {
      redirect(res, `/connections/login?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`);
      return;
    }
    const subject = await this.options.directory.lookup(session.email);
    if (!subject) {
      this.sendUnknownSubject(res, session, url);
      return;
    }
    const need = chainOrder(this.knownProviders(url.searchParams.get("need")));
    if (need.length === 0) {
      redirect(res, "/connections");
      return;
    }
    await this.advanceChain(res, subject, { need, attempted: [] });
  }

  /** Where a provider's callback lands mid-chain; see {@link completionRedirect}. */
  private async handleLinkNext(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const session = this.session(req);
    if (!session) {
      redirect(res, `/connections/login?${new URLSearchParams({ next: url.pathname })}`);
      return;
    }
    const raw = readCookie(req, RETURN_COOKIE);
    res.appendHeader("set-cookie", this.cookie(RETURN_COOKIE, "", { path: "/", maxAgeSeconds: 0 }));
    const chain = raw ? readChain(verifyToken(raw, CHAIN_PURPOSE, this.options.cookieKey, this.now())) : undefined;
    const subject = await this.options.directory.lookup(session.email);
    if (!chain || !subject) {
      redirect(res, "/connections");
      return;
    }
    // Signed by us, but a provider can be configured away mid-chain.
    await this.advanceChain(res, subject, { ...chain, need: chain.need.filter((id) => this.providers.has(id)) });
  }

  /**
   * One step of a chain: re-read every needed provider's status, then either
   * finish, stop on the page, or send the browser to the next provider.
   *
   * A provider is tried at most once per chain. If one this chain already
   * sent the user through still isn't connected -- its link reported success
   * but nothing persisted -- the chain stops on the page rather than offering
   * it again, which would otherwise loop forever.
   */
  private async advanceChain(res: ServerResponse, subject: string, chain: Chain): Promise<void> {
    const missing: string[] = [];
    for (const id of chain.need) {
      const status = await this.statusOf(this.providers.get(id)!, subject);
      if (status.state !== "connected") missing.push(id);
    }
    if (missing.length === 0) {
      this.sendPage(
        res,
        200,
        renderMessagePage("You're all set", "Everything your chat needed is connected. Go back to your chat to carry on.", {
          href: "/connections",
          label: "Manage your connections",
        }),
      );
      return;
    }
    const stop = (flash: string) => redirect(res, withNeed(`/connections?${flash}`, missing.join(",")));
    const next = missing[0]!;
    if (chain.attempted.includes(next)) {
      console.error(`connections: ${next} still isn't connected after this chain linked it; stopping on the page`);
      stop(`error=connect`);
      return;
    }
    let started;
    try {
      started = await this.providers.get(next)!.connect(subject);
    } catch (err) {
      console.error(`connections: connect ${next} failed:`, err instanceof Error ? err.message : err);
      stop(`error=connect`);
      return;
    }
    if ("blocked" in started) {
      stop(`blocked=${encodeURIComponent(next)}`);
      return;
    }
    const token = signToken(
      { provider: next, need: missing.join(","), chainNeed: chain.need, attempted: [...chain.attempted, next] },
      RETURN_COOKIE,
      this.options.cookieKey,
      this.now() + RETURN_TTL_MS,
    );
    res.appendHeader("set-cookie", this.cookie(RETURN_COOKIE, token, { path: "/", maxAgeSeconds: RETURN_TTL_MS / 1000 }));
    redirect(res, started.redirect);
  }

  private statusOf(provider: ConnectionProvider, subject: string): Promise<ConnectionStatus> {
    return provider.status(subject).catch((err: unknown) => {
      console.error(`connections: status for ${provider.id} failed:`, err instanceof Error ? err.message : err);
      return { state: "not-connected" as const };
    });
  }

  /** The providers a `need` list names that this gateway can link, de-duplicated, in the order given. */
  private knownProviders(need: string | null): string[] {
    const ids = (need ?? "").split(",").map((s) => s.trim());
    return [...new Set(ids.filter((s) => this.providers.has(s)))];
  }

  private sendUnknownSubject(res: ServerResponse, session: Session, url: URL): void {
    this.sendPage(
      res,
      200,
      renderMessagePage(
        "Send a chat message first",
        `You're signed in as ${session.email}, but we haven't seen that account in chat yet. Send any message in chat, then reload this page.`,
        { href: url.pathname + url.search, label: "Reload" },
      ),
    );
  }

  private async handleLogin(res: ServerResponse, url: URL): Promise<void> {
    let begun: { authorizeUrl: string; pending: PendingLogin };
    try {
      begun = await this.options.oidc.begin();
    } catch (err) {
      console.error("connections: OIDC login could not start:", err instanceof Error ? err.message : err);
      this.sendPage(res, 502, renderMessagePage("Sign-in is unavailable", "We couldn't reach the sign-in provider. Please try again shortly."));
      return;
    }
    const next = safeNext(url.searchParams.get("next"));
    const token = signToken({ ...begun.pending, next }, LOGIN_COOKIE, this.options.cookieKey, this.now() + LOGIN_TTL_MS);
    res.appendHeader(
      "set-cookie",
      this.cookie(LOGIN_COOKIE, token, { path: "/connections", maxAgeSeconds: LOGIN_TTL_MS / 1000 }),
    );
    redirect(res, begun.authorizeUrl);
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = readCookie(req, LOGIN_COOKIE);
    res.appendHeader("set-cookie", this.cookie(LOGIN_COOKIE, "", { path: "/connections", maxAgeSeconds: 0 }));
    const login = raw ? verifyToken(raw, LOGIN_COOKIE, this.options.cookieKey, this.now()) : undefined;
    const code = url.searchParams.get("code");
    const retry = { href: "/connections", label: "Try again" };
    if (
      !login ||
      typeof login.state !== "string" ||
      typeof login.nonce !== "string" ||
      typeof login.codeVerifier !== "string" ||
      login.state !== url.searchParams.get("state") ||
      !code
    ) {
      this.sendPage(res, 400, renderMessagePage("Sign-in expired", "That sign-in attempt expired or didn't match. Please sign in again.", retry));
      return;
    }
    const result = await this.options.oidc.complete(code, {
      state: login.state,
      nonce: login.nonce,
      codeVerifier: login.codeVerifier,
    });
    if (!result.ok) {
      const message =
        result.reason === "email-unverified"
          ? "Your sign-in account's email address isn't verified. Verify it with your identity provider, then try again."
          : result.reason === "no-email"
            ? "Your sign-in account has no email address, which this page needs to find your chat account."
            : "Sign-in didn't complete. Please try again.";
      console.error(`connections: OIDC login failed: ${result.reason}`);
      this.sendPage(res, 403, renderMessagePage("Couldn't sign you in", message, retry));
      return;
    }
    const session = signToken(
      { email: result.email, csrf: randomBytes(16).toString("base64url") },
      SESSION_COOKIE,
      this.options.cookieKey,
      this.now() + this.options.sessionTtlMs,
    );
    res.appendHeader(
      "set-cookie",
      this.cookie(SESSION_COOKIE, session, { path: "/connections", maxAgeSeconds: this.options.sessionTtlMs / 1000 }),
    );
    redirect(res, safeNext(typeof login.next === "string" ? login.next : null));
  }

  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const session = this.session(req);
    if (session && form.get("csrf") !== session.csrf) {
      res.writeHead(403).end();
      return;
    }
    res.appendHeader("set-cookie", this.cookie(SESSION_COOKIE, "", { path: "/connections", maxAgeSeconds: 0 }));
    this.sendPage(res, 200, renderMessagePage("Signed out", "You've signed out of Connections.", { href: "/connections", label: "Sign in again" }));
  }

  private async handleConnect(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const ctx = await this.authorizedForm(req, res, id);
    if (!ctx) return;
    const need = ctx.form.get("need") ?? "";
    let started;
    try {
      started = await ctx.provider.connect(ctx.subject);
    } catch (err) {
      console.error(`connections: connect ${id} failed:`, err instanceof Error ? err.message : err);
      redirect(res, withNeed(`/connections?error=connect`, need), 303);
      return;
    }
    if ("blocked" in started) {
      redirect(res, withNeed(`/connections?blocked=${encodeURIComponent(id)}`, need), 303);
      return;
    }
    const token = signToken({ provider: id, need }, RETURN_COOKIE, this.options.cookieKey, this.now() + RETURN_TTL_MS);
    res.appendHeader("set-cookie", this.cookie(RETURN_COOKIE, token, { path: "/", maxAgeSeconds: RETURN_TTL_MS / 1000 }));
    redirect(res, started.redirect, 303);
  }

  private async handleDisconnect(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const ctx = await this.authorizedForm(req, res, id);
    if (!ctx) return;
    try {
      await ctx.provider.disconnect(ctx.subject);
    } catch (err) {
      console.error(`connections: disconnect ${id} failed:`, err instanceof Error ? err.message : err);
      redirect(res, `/connections?error=disconnect`, 303);
      return;
    }
    redirect(res, `/connections?disconnected=${encodeURIComponent(id)}`, 303);
  }

  /**
   * The checks every state-changing route shares: a signed-in session, a
   * matching CSRF token (on top of the cookie's SameSite=Lax), a known
   * provider, and a chat subject to act on.
   */
  private async authorizedForm(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<{ provider: ConnectionProvider; subject: string; form: URLSearchParams } | undefined> {
    const form = await readForm(req);
    const session = this.session(req);
    if (!session) {
      redirect(res, "/connections/login", 303);
      return undefined;
    }
    if (form.get("csrf") !== session.csrf) {
      res.writeHead(403).end();
      return undefined;
    }
    const provider = PROVIDER_ID.test(id) ? this.providers.get(id) : undefined;
    if (!provider) {
      res.writeHead(404).end();
      return undefined;
    }
    const subject = await this.options.directory.lookup(session.email);
    if (!subject) {
      redirect(res, "/connections", 303);
      return undefined;
    }
    return { provider, subject, form };
  }

  private session(req: IncomingMessage): Session | undefined {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) return undefined;
    const payload = verifyToken(raw, SESSION_COOKIE, this.options.cookieKey, this.now());
    if (!payload || typeof payload.email !== "string" || typeof payload.csrf !== "string") return undefined;
    return { email: payload.email, csrf: payload.csrf };
  }

  private cookie(name: string, value: string, opts: { path: string; maxAgeSeconds: number }): string {
    return [
      `${name}=${value}`,
      `Path=${opts.path}`,
      `Max-Age=${Math.floor(opts.maxAgeSeconds)}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(this.secure ? ["Secure"] : []),
    ].join("; ");
  }

  private sendPage(res: ServerResponse, status: number, html: string): void {
    res
      .writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // No `form-action`: Chrome applies it to the redirect a form post
        // answers with, and Connect's answer is a redirect to the provider.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        "referrer-policy": "same-origin",
      })
      .end(html);
  }
}

/** Only same-site paths under `/connections`: anything else is an open redirect. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/connections") || next.startsWith("//")) return "/connections";
  return next;
}

function withNeed(path: string, need: string): string {
  return need ? `${path}&need=${encodeURIComponent(need)}` : path;
}

function redirect(res: ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location, "cache-control": "no-store" }).end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // These are tiny forms and one small JSON body; anything large is not ours.
      if (size > 64 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}
