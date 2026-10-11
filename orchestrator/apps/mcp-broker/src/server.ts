import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { authenticate, UnauthorizedError, type AuthConfig } from "./auth.js";
import { flattenToolResult, McpTransportError, type McpClient } from "./mcp-client.js";
import { exposureByRemoteName, isExposed } from "./mcp-server-resource.js";
import type { MCPServerRegistry } from "./mcpserver-registry.js";

/**
 * The broker's invocation surface (ADR 0045 §3, §5) — one route:
 *
 *   POST /servers/:server/tools/:remoteTool/call
 *   GET  /healthz
 *
 * It proxies ONE tools/call to the named server and maps the result back. The
 * engines never speak MCP; they call this, and the protocol stays quarantined
 * behind it.
 *
 * The auth model is deliberately strict and fails closed in two places:
 *
 *   - The caller must present the ORCHESTRATOR_TOKEN (auth.ts), or 401.
 *   - If the server declares identityProviders, the call runs as the USER: the
 *     caller must forward that user's token in `x-delegated-token`, or the call
 *     is refused 403. It NEVER falls back to the discovery/service credential —
 *     a per-user call quietly becoming a shared-identity call is exactly the
 *     failure this design forbids (§5).
 *
 * All non-2xx bodies are `{ "message": "..." }`.
 */
export interface ServerOptions {
  auth: AuthConfig;
  registry: MCPServerRegistry;
  client: McpClient;
}

/** Header carrying the calling user's per-user delegated token, per request. */
export const DELEGATED_TOKEN_HEADER = "x-delegated-token";

export function createMcpBrokerServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    void handle(options, req, res).catch((err: unknown) => {
      console.error("mcp-broker request failed:", err);
      if (!res.headersSent) send(res, 500, { message: "internal error" });
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
  if (!route || req.method !== "POST") {
    send(res, 404, { message: "not found" });
    return;
  }

  // 1. Is this the engine at all? Fail closed on any other bearer.
  try {
    authenticate(options.auth, header(req, "authorization"));
  } catch (err) {
    if (err instanceof UnauthorizedError) return send(res, 401, { message: err.message });
    throw err;
  }

  // 2. Known server?
  const binding = options.registry.get(route.server);
  if (!binding) {
    return send(res, 404, { message: `no such server: ${route.server}` });
  }
  const server = binding.cr;

  // 3. Known, EXPOSED tool? The operator's exposure map is truth for
  //    permission (§6): the broker refuses to proxy a tool the operator did not
  //    expose, even if the server advertises it — defense in depth behind the
  //    catalog's own RBAC filter.
  const entry = exposureByRemoteName(server).get(route.remoteTool);
  if (!entry || !isExposed(entry)) {
    return send(res, 404, { message: `no such tool on ${route.server}: ${route.remoteTool}` });
  }

  // 4. Which credential, and fail closed when a per-user call has no user.
  const needsUser = (server.spec.identityProviders ?? []).length > 0;
  const delegated = header(req, DELEGATED_TOKEN_HEADER)?.trim();
  if (needsUser && !delegated) {
    return send(res, 403, {
      message:
        `server ${route.server} runs tools as the calling user, but no ${DELEGATED_TOKEN_HEADER} ` +
        `was provided; refusing to fall back to the discovery credential`,
    });
  }
  // A per-user server spends the delegated token; a shared server spends the
  // service credential (which may be undefined, i.e. an unauthenticated call).
  const token = needsUser ? delegated : binding.serviceToken;

  // 5. The arguments object from the body.
  const body = await readJson(req);
  const args =
    typeof body.arguments === "object" && body.arguments !== null && !Array.isArray(body.arguments)
      ? (body.arguments as Record<string, unknown>)
      : {};

  // 6. Proxy the single tools/call.
  try {
    const result = await options.client.callTool({
      url: server.spec.url,
      token,
      name: route.remoteTool,
      arguments: args,
    });
    const flattened = flattenToolResult(result);
    return send(res, 200, flattened);
  } catch (err) {
    // A transport/protocol failure is the server's fault, not the caller's.
    if (err instanceof McpTransportError) return send(res, 502, { message: err.message });
    throw err;
  }
}

interface Route {
  server: string;
  remoteTool: string;
}

/** Parses `/servers/:server/tools/:remoteTool/call`. */
function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5) return undefined;
  if (parts[0] !== "servers" || parts[2] !== "tools" || parts[4] !== "call") return undefined;
  if (!parts[1] || !parts[3]) return undefined;
  return { server: decodeURIComponent(parts[1]), remoteTool: decodeURIComponent(parts[3]) };
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
    // Tool arguments are small; anything larger is not a tool call we proxy.
    if (size > 1024 * 1024) throw new Error("request body too large");
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
