import type { IncomingMessage, ServerResponse } from "node:http";
import type { GithubDeviceFlowLinker } from "./device-flow-linker.js";

/** Only `github` is supported today -- any other `:provider` segment is a 400, not a 404, since the route itself matched. */
const SUPPORTED_PROVIDERS = new Set(["github"]);

/** Hard ceiling on `/wait`'s `timeoutMs`, matching the authcode `state` TTL -- a caller can't hold this route open longer than a link attempt could possibly still be valid for. */
const MAX_WAIT_MS = 10 * 60 * 1000;

/** Checks `Authorization: Bearer <expectedToken>`. Mirrors `orchestrator-client.ts`'s `Bearer ${token}` framing, but this gateway is the one checking it here (not sending it). */
export function checkBearer(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || !expectedToken) return false;
  const match = /^Bearer (.+)$/.exec(header);
  return match !== null && match[1] === expectedToken;
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

function htmlPage(title: string, message: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${message}</p>
</body>
</html>`;
}

/**
 * Internal API (orchestrator -> this gateway) for linking/using a chat user's
 * own GitHub identity via OAuth Device Flow (see docs on
 * `GithubDeviceFlowLinker`). Every route requires
 * `Authorization: Bearer <identityLinkToken>` -- a separate token from
 * `orchestratorToken`, since that one flows the opposite direction
 * (gateway -> orchestrator).
 */
export class IdentityLinkApi {
  constructor(
    private readonly linker: GithubDeviceFlowLinker,
    private readonly identityLinkToken: string,
  ) {}

  /**
   * Routes the unauthenticated `GET /identity-link/:provider/callback`
   * redirect target for the OAuth authorization-code flow. This is hit
   * directly by the end user's browser (via GitHub's redirect), which
   * cannot carry our internal bearer token -- so, unlike `handle`, this
   * method does NOT check `Authorization`. Callers must dispatch to this
   * BEFORE the bearer-gated `handle` above, since that one would otherwise
   * 401 every request to this path. Returns `false` if the path didn't match
   * this route at all.
   */
  async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (req.method !== "GET" || segments[0] !== "identity-link" || segments.length !== 3 || segments[2] !== "callback") {
      return false;
    }
    const provider = segments[1]!;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      res.writeHead(400, { "content-type": "text/plain" }).end(`Unsupported identity provider: ${provider}`);
      return true;
    }

    const state = url.searchParams.get("state");
    if (!state) {
      sendHtml(
        res,
        400,
        htmlPage("Link request malformed", "This link is missing required information. Please try again from chat."),
      );
      return true;
    }

    const error = url.searchParams.get("error");
    if (error) {
      // GitHub's denial redirect (e.g. the user clicked "Cancel"). This is a
      // completed-but-declined flow, not really an error condition, so 200.
      sendHtml(
        res,
        200,
        htmlPage("GitHub link cancelled", "You declined the request. You can try again from chat whenever you're ready."),
      );
      return true;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      sendHtml(
        res,
        400,
        htmlPage("Link request malformed", "This link is missing required information. Please try again from chat."),
      );
      return true;
    }

    const completed = await this.linker.completeAuthCode(state, code);
    if (!completed) {
      sendHtml(
        res,
        400,
        htmlPage("Link expired", "This link may have expired or already been used -- please try again from chat."),
      );
      return true;
    }

    sendHtml(
      res,
      200,
      htmlPage("GitHub account linked", "You can close this tab and return to your chat."),
    );
    return true;
  }

  /**
   * Routes a request whose path matches `/identity-link/:provider/...`.
   * Returns `false` if the path didn't match this API at all (caller should
   * fall through to its own 404), otherwise handles the request (including
   * writing any error response) and returns `true`.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "identity-link" || segments.length !== 3) return false;
    const [, provider, action] = segments as [string, string, string];

    if (!checkBearer(req, this.identityLinkToken)) {
      res.writeHead(401).end();
      return true;
    }

    if (req.method === "POST" && action === "start") {
      await this.handleStart(req, res, provider!);
      return true;
    }
    if (req.method === "POST" && action === "poll") {
      await this.handlePoll(req, res, provider!);
      return true;
    }
    if (req.method === "GET" && action === "token") {
      await this.handleToken(res, url, provider!);
      return true;
    }
    if (req.method === "POST" && action === "wait") {
      await this.handleWait(req, res, provider!);
      return true;
    }
    res.writeHead(404).end();
    return true;
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse, provider: string): Promise<void> {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      sendJson(res, 400, { error: `Unsupported identity provider: ${provider}` });
      return;
    }
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };

    const rawFlow = (body as { flow?: unknown }).flow;
    if (rawFlow !== undefined && rawFlow !== "device" && rawFlow !== "authcode") {
      sendJson(res, 400, { error: '`flow` must be "device" or "authcode" if present' });
      return;
    }
    // This API-layer default ("device") is intentionally independent of
    // whatever default agent-orchestrator itself applies -- this API has no
    // opinion about caller context.
    const flow = rawFlow ?? "device";

    if (flow === "authcode") {
      const started = await this.linker.startAuthCode(subject);
      sendJson(res, 200, started);
      return;
    }
    const started = await this.linker.start(subject);
    sendJson(res, 200, { flow: "device", ...started });
  }

  private async handlePoll(req: IncomingMessage, res: ServerResponse, provider: string): Promise<void> {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      sendJson(res, 400, { error: `Unsupported identity provider: ${provider}` });
      return;
    }
    const body = await parseJsonBody(req);
    if (
      !body ||
      typeof (body as { subject?: unknown }).subject !== "string" ||
      typeof (body as { deviceCode?: unknown }).deviceCode !== "string"
    ) {
      sendJson(res, 400, { error: "Request body must be JSON with string `subject` and `deviceCode` fields" });
      return;
    }
    const { subject, deviceCode } = body as { subject: string; deviceCode: string };
    const polled = await this.linker.poll(subject, deviceCode);
    sendJson(res, 200, polled);
  }

  /**
   * Long-held route: blocks (up to `timeoutMs`, capped at `MAX_WAIT_MS`)
   * until a token lands for `subject`, letting agent-orchestrator hold a
   * streaming chat turn open across the OAuth browser round-trip instead of
   * requiring the caller to send a follow-up chat message.
   */
  private async handleWait(req: IncomingMessage, res: ServerResponse, provider: string): Promise<void> {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      sendJson(res, 400, { error: `Unsupported identity provider: ${provider}` });
      return;
    }
    const body = await parseJsonBody(req);
    if (!body || typeof (body as { subject?: unknown }).subject !== "string") {
      sendJson(res, 400, { error: "Request body must be JSON with a string `subject` field" });
      return;
    }
    const { subject } = body as { subject: string };
    const rawTimeout = (body as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof rawTimeout === "number" && rawTimeout > 0 ? Math.min(rawTimeout, MAX_WAIT_MS) : MAX_WAIT_MS;

    const token = await this.linker.waitForCompletion(subject, timeoutMs);
    if (!token) {
      sendJson(res, 200, { status: "timeout" });
      return;
    }
    sendJson(res, 200, { status: "complete", token: { token: token.token, githubLogin: token.githubLogin } });
  }

  private async handleToken(res: ServerResponse, url: URL, provider: string): Promise<void> {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      sendJson(res, 400, { error: `Unsupported identity provider: ${provider}` });
      return;
    }
    const subject = url.searchParams.get("subject");
    if (!subject) {
      sendJson(res, 400, { error: "Query parameter `subject` is required" });
      return;
    }
    const token = await this.linker.getValidToken(subject);
    if (!token) {
      res.writeHead(404).end();
      return;
    }
    sendJson(res, 200, token);
  }
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
