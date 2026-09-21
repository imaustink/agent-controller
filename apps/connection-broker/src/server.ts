import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  authenticate,
  authorize,
  ForbiddenError,
  UnauthorizedError,
  type AuthConfig,
  type Operation,
} from "./auth.js";
import {
  PermanentError,
  PermissionDeniedError,
  TransientError,
  type Credentials,
} from "./drivers/types.js";
import type { ConnectionRegistry } from "./registry.js";

/**
 * The broker's HTTP surface (docs/adr/0038 §3).
 *
 * Three operations, and which credential each may spend is decided by auth.ts
 * rather than by the route — so a new route cannot accidentally hand a
 * request-path caller the ingestion credential.
 *
 *   GET  /connections/:name/resources          — incremental listing (sync only)
 *   GET  /connections/:name/resources/:id      — one document
 *   POST /connections/:name/probe              — per-user authorization (ADR 0040)
 */
export interface ServerOptions {
  auth: AuthConfig;
  registry: ConnectionRegistry;
  /**
   * Webhook support, absent when this broker does not index.
   *
   * `secretFor` returns the shared secret the provider signs with; a connection
   * without one cannot receive webhooks, which is a configuration state rather
   * than an error — it simply stays on its reconcile interval.
   */
  webhooks?: {
    secretFor: (connection: string) => string | undefined;
    /**
     * Schedules a pass for the named resources. An EMPTY list means "something
     * changed, we do not know what", which must escalate to a full pass rather
     * than be dropped.
     */
    onChange: (connection: string, sourceIds: string[]) => void;
  };
}

/** Header carrying the calling user's delegated token, per request. */
export const DELEGATED_TOKEN_HEADER = "x-delegated-token";

export function createBrokerServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    void handle(options, req, res).catch((err: unknown) => {
      // Nothing below should throw uncaught; if it does, do not leak internals.
      console.error("broker request failed:", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
}

async function handle(
  options: ServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://broker.invalid");

  if (url.pathname === "/healthz") {
    send(res, 200, { ok: true });
    return;
  }

  const route = parseRoute(url.pathname);
  if (!route) {
    send(res, 404, { error: "not found" });
    return;
  }

  // Webhooks are authenticated by the PROVIDER's signature, not by a bearer
  // token: the caller is Confluence or Slack, which hold no credential of ours.
  // Handled before the bearer path so an unsigned request cannot fall through
  // into it.
  if (route.kind === "webhook") {
    await handleWebhook(options, route.connection, req, res);
    return;
  }

  let credential: "service" | "delegated";
  const delegated = header(req, DELEGATED_TOKEN_HEADER);
  try {
    const caller = authenticate(options.auth, header(req, "authorization"));
    const operation: Operation =
      route.kind === "probe" ? "probe" : route.id ? "fetch" : "list";
    ({ credential } = authorize(caller, operation, route.connection, delegated));
  } catch (err) {
    if (err instanceof UnauthorizedError) return send(res, 401, { error: err.message });
    if (err instanceof ForbiddenError) return send(res, 403, { error: err.message });
    throw err;
  }

  const binding = options.registry.get(route.connection);
  if (!binding) {
    send(res, 404, { error: `no such connection: ${route.connection}` });
    return;
  }

  // Only ever hand the driver the credential authorization actually granted.
  const credentials: Credentials =
    credential === "service" ? { service: binding.serviceToken } : { delegated };

  try {
    if (route.kind === "probe") {
      const body = await readJson(req);
      const result = await binding.driver.probe(
        binding.scope,
        credentials,
        typeof body.sourceId === "string" ? body.sourceId : undefined,
      );
      send(res, 200, result);
      return;
    }

    if (route.id) {
      const document = await binding.driver.fetch(binding.scope, credentials, route.id);
      send(res, 200, document);
      return;
    }

    const page = await binding.driver.list(
      binding.scope,
      credentials,
      url.searchParams.get("cursor") ?? undefined,
    );
    send(res, 200, page);
  } catch (err) {
    // The distinction the caller must be able to act on (ADR 0040): 403 is a
    // drop, 503 is "we could not find out" and must never become a silent
    // omission.
    if (err instanceof PermissionDeniedError) return send(res, 403, { error: err.message });
    if (err instanceof TransientError) return send(res, 503, { error: err.message });
    // Deliberately NOT 503: the caller retries those, and this is the one
    // failure retrying can never fix. 500 stops the loop and puts the
    // provider's own explanation where an operator will read it.
    if (err instanceof PermanentError) return send(res, 500, { error: err.message });
    throw err;
  }
}

interface Route {
  connection: string;
  kind: "resources" | "probe" | "webhook";
  id?: string;
}

/**
 * Handles a provider change notification.
 *
 * This endpoint is reachable by anyone who can route to the pod, so the
 * driver's signature check is the entire boundary. Everything here fails
 * closed: no webhook support, no secret, no driver support, or a signature that
 * does not verify all end the request without touching a credential.
 *
 * It deliberately answers 200 to a VERIFIED notification it does not act on.
 * Providers disable endpoints that keep returning errors, and "this event was
 * not about anything we index" is a normal outcome, not a failure.
 */
async function handleWebhook(
  options: ServerOptions,
  connection: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const webhooks = options.webhooks;
  const binding = options.registry.get(connection);

  // Deliberately the same answer for "unknown connection", "webhooks off" and
  // "no secret configured": a distinguishable response here would let an
  // unauthenticated caller enumerate which connections exist.
  if (!webhooks || !binding || !binding.driver.parseWebhook) {
    send(res, 404, { error: "not found" });
    return;
  }
  const secret = webhooks.secretFor(connection);
  if (!secret) {
    send(res, 404, { error: "not found" });
    return;
  }

  // The bytes as received: a signature is computed over them, so a parsed and
  // re-stringified body verifies against nothing.
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = binding.driver.parseWebhook(
      { headers: req.headers as Record<string, string | undefined>, rawBody },
      secret,
      binding.scope,
    );
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return send(res, 401, { error: "signature verification failed" });
    }
    throw err;
  }

  // Verified, but not about anything this connection indexes.
  if (!event) return send(res, 200, { ok: true, acted: false });

  webhooks.onChange(connection, event.sourceIds);
  send(res, 202, { ok: true, acted: true, resources: event.sourceIds.length });
}

function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "connections" || !parts[1]) return undefined;
  const connection = decodeURIComponent(parts[1]);

  if (parts[2] === "probe" && parts.length === 3) return { connection, kind: "probe" };
  if (parts[2] === "webhook" && parts.length === 3) return { connection, kind: "webhook" };
  if (parts[2] === "resources") {
    if (parts.length === 3) return { connection, kind: "resources" };
    if (parts.length === 4) {
      return { connection, kind: "resources", id: decodeURIComponent(parts[3]!) };
    }
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A probe body is a few fields; anything larger is not a probe.
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The body as BYTES, for signature verification.
 *
 * Separate from readJson because a signature is computed over exactly what was
 * sent: parsing and re-stringifying reorders keys and drops whitespace, and the
 * result verifies against nothing.
 *
 * Bounded like every other body here — this endpoint is unauthenticated until
 * the signature has been checked, and the signature cannot be checked until the
 * body is read, so the limit is the only thing bounding an anonymous request.
 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("webhook body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
