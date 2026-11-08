import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context carried alongside a single MCP request.
 *
 * The streamable-http transport dispatches a tools/call to the registered tool
 * callback WITHOUT handing it the underlying HTTP request, so a tool cannot read
 * the inbound Authorization header on its own. We bridge that gap with an
 * AsyncLocalStorage store: the HTTP handler reads the header once, then runs the
 * whole `transport.handleRequest(...)` inside `requestContext.run(store, ...)`.
 * Because the SDK awaits the tool callback within that same async context, the
 * callback can recover the token via `getBearerToken()`.
 *
 * This is what lets the `whoami` tool reflect the CALLER's per-user delegated
 * token — the whole point of the fixture.
 */
export interface RequestContext {
  /** The raw Authorization header value as received, e.g. "Bearer abc123". */
  authorization?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the Bearer token from the current request's Authorization header, or
 * the literal "anonymous" when no (or no Bearer) credential was presented.
 *
 * The match is case-insensitive on the "Bearer" scheme and tolerant of extra
 * whitespace, mirroring a lenient server. This fixture enforces nothing — it
 * only REFLECTS — so any value (including an empty bearer) is accepted.
 */
export function getBearerToken(): string {
  const authorization = requestContext.getStore()?.authorization;
  if (!authorization) return "anonymous";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match || !match[1]) return "anonymous";
  return match[1].trim() || "anonymous";
}
