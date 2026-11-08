/**
 * Caller authentication and authorization for the broker.
 *
 * The broker holds every client's third-party credentials and will make
 * outbound calls on behalf of whoever asks. That makes it a confused deputy by
 * construction (docs/adr/0038 §3), and this module is the mitigation: it is not
 * enough to know a caller is inside the cluster, because the question that
 * matters is WHICH CREDENTIAL a given caller may cause to be used.
 *
 * Two caller classes, with deliberately different powers:
 *
 *   - The ORCHESTRATOR may probe and read on behalf of a user, and must supply
 *     that user's delegated token. It can never cause a connection's service
 *     credential to be used — which is the whole point, since a compromised or
 *     confused orchestrator would otherwise be able to read every client's
 *     entire corpus with the ingestion credential.
 *   - A SYNC worker may list and fetch with the service credential, for exactly
 *     ONE connection: the one it was issued a token for. Ingestion deliberately
 *     ignores permissions (docs/adr/0040), so that power is scoped as narrowly
 *     as it can be.
 */

import { timingSafeEqual } from "node:crypto";

export type CallerKind = "orchestrator" | "sync";

export interface Caller {
  kind: CallerKind;
  /** For a sync caller, the single connection it may act on. */
  connection?: string;
}

export class UnauthorizedError extends Error {
  readonly name = "UnauthorizedError";
}

export class ForbiddenError extends Error {
  readonly name = "ForbiddenError";
}

export interface AuthConfig {
  /** Shared secret the orchestrator presents. */
  orchestratorToken: string;
  /**
   * Per-connection sync tokens. One token per connection rather than one for
   * all of them, so a leaked sync credential reaches one client's source
   * instead of every client's.
   */
  syncTokens: ReadonlyMap<string, string>;
}

/** Constant-time compare that tolerates differing lengths without leaking them. */
function secretsMatch(presented: string, expected: string): boolean {
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
 * Identifies the caller from its bearer token.
 *
 * Fails closed: an unrecognized or absent token is never treated as an
 * anonymous caller with reduced powers, because "reduced powers" here still
 * means "can spend somebody's credential".
 */
export function authenticate(config: AuthConfig, authorization: string | undefined): Caller {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new UnauthorizedError("missing bearer token");

  if (config.orchestratorToken && secretsMatch(token, config.orchestratorToken)) {
    return { kind: "orchestrator" };
  }
  for (const [connection, expected] of config.syncTokens) {
    if (secretsMatch(token, expected)) return { kind: "sync", connection };
  }
  throw new UnauthorizedError("unrecognized bearer token");
}

export type Operation = "list" | "fetch" | "probe";

/**
 * Decides whether this caller may perform this operation on this connection,
 * and WHICH credential it may cause to be used.
 *
 * The returned credential kind is the load-bearing part. Authorization here is
 * not just "may you call me" but "may you spend the service credential", and
 * only a sync worker acting on its own connection ever may.
 */
export function authorize(
  caller: Caller,
  operation: Operation,
  connection: string,
  delegatedToken: string | undefined,
): { credential: "service" | "delegated" } {
  if (caller.kind === "sync") {
    if (caller.connection !== connection) {
      throw new ForbiddenError(
        `sync caller for ${caller.connection} may not act on ${connection}`,
      );
    }
    if (operation === "probe") {
      // A probe answers "may this USER read it", and a sync worker has no user.
      throw new ForbiddenError("a sync caller cannot probe on behalf of a user");
    }
    return { credential: "service" };
  }

  // Orchestrator.
  if (operation === "list") {
    // Listing is an ingestion operation and runs on the service credential;
    // letting the orchestrator drive it would hand a request-path component the
    // ability to enumerate a whole corpus with the ingestion credential.
    throw new ForbiddenError("the orchestrator may not list; that is the sync worker's operation");
  }
  if (!delegatedToken) {
    throw new ForbiddenError(
      "the orchestrator must supply the calling user's delegated token; it may not use the service credential",
    );
  }
  return { credential: "delegated" };
}
