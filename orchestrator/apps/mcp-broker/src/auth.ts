/**
 * Caller authentication for the broker's invocation API (docs/adr/0045 §5).
 *
 * The broker proxies a tools/call to an externally-controlled MCP server, under
 * a credential the caller supplies. That makes it a confused deputy by
 * construction (same posture as connection-broker, ADR 0038 §3), and this
 * module is the first gate: only the agent engines, holding the shared
 * ORCHESTRATOR_TOKEN, may ask the broker to invoke anything at all.
 *
 * There is exactly ONE caller class here — the orchestrator/engine — unlike
 * connection-broker, which also serves a sync worker. The broker never spends a
 * per-connection credential of its own on a caller's behalf: invocation runs as
 * the user, via the delegated token the caller forwards (see server.ts). So the
 * only question this module answers is "is this the engine", and it answers it
 * fail-closed.
 */

import { timingSafeEqual } from "node:crypto";

export class UnauthorizedError extends Error {
  readonly name = "UnauthorizedError";
}

export interface AuthConfig {
  /** Shared secret the agent engines present. Mirrors connection-broker. */
  orchestratorToken: string;
}

/** Constant-time compare that tolerates differing lengths without leaking them. */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the failure is not distinguishable by timing.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Accepts the caller only if it presents the orchestrator token.
 *
 * Fails closed: a missing, empty or unrecognized bearer is rejected rather than
 * treated as an anonymous caller with reduced powers — there are no reduced
 * powers here, every accepted caller may cause a tools/call to run.
 */
export function authenticate(config: AuthConfig, authorization: string | undefined): void {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new UnauthorizedError("missing bearer token");
  if (config.orchestratorToken && secretsMatch(token, config.orchestratorToken)) return;
  throw new UnauthorizedError("unrecognized bearer token");
}
