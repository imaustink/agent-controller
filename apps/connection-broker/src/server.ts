import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  authenticate,
  authorize,
  ForbiddenError,
  UnauthorizedError,
  type AuthConfig,
  type Operation,
} from "./auth.js";
import { PermissionDeniedError, TransientError, type Credentials } from "./drivers/types.js";
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
    throw err;
  }
}

interface Route {
  connection: string;
  kind: "resources" | "probe";
  id?: string;
}

function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "connections" || !parts[1]) return undefined;
  const connection = decodeURIComponent(parts[1]);

  if (parts[2] === "probe" && parts.length === 3) return { connection, kind: "probe" };
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
