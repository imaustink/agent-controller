/** Resolved caller identity used to scope RAG retrieval and Job launch permissions. */
export interface Identity {
  /**
   * The identity as the ENTRY POINT resolved it -- `openwebui:<id>` for chat,
   * the gateway's service subject for a webhook relay, an IdP `sub` for OIDC.
   *
   * Entry-point-specific by nature, which is why it is the wrong thing to key
   * durable per-user state on: the same human arriving through two entry
   * points has two different subjects. Still the right key for anything
   * genuinely scoped to that entry point (sessions, its own GitHub link).
   */
  subject: string;
  roles: string[];
  /**
   * Stable identifier for the HUMAN, independent of how they arrived
   * (docs/adr/0030 §6).
   *
   * Entry-point subjects are aliases of this. Durable per-user state --
   * notably the Claude credentials -- keys on the principal, so authorizing
   * once during GitHub triage is honored in Open WebUI chat and vice versa,
   * which is the entire bug this exists to fix.
   *
   * Today a principal is `github:<login>` when a verified GitHub identity can
   * be established for the caller, and otherwise the raw `subject` acting as
   * its own principal. That fallback matters: a caller with no GitHub linkage
   * still works, they simply get no cross-entry-point sharing, which is
   * exactly the pre-principal behavior rather than a failure.
   *
   * Optional so an `Identity` built by a resolver that predates this (or by a
   * test) still type-checks; consumers fall back to `subject`.
   */
  principal?: string;
}

/**
 * Port for turning a caller-supplied auth token into an {@link Identity}.
 * MUST fail closed: return `undefined` on any verification failure rather
 * than throwing partial/guessed roles (ADR 0004, docs/orchestrator.md#security-considerations).
 */
export interface IdentityResolver {
  resolve(authToken: string): Promise<Identity | undefined>;
}
