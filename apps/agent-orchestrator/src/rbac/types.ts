/** Resolved caller identity used to scope RAG retrieval and Job launch permissions. */
export interface Identity {
  subject: string;
  roles: string[];
}

/**
 * Port for turning a caller-supplied auth token into an {@link Identity}.
 * MUST fail closed: return `undefined` on any verification failure rather
 * than throwing partial/guessed roles (ADR 0004, docs/orchestrator.md#security-considerations).
 */
export interface IdentityResolver {
  resolve(authToken: string): Promise<Identity | undefined>;
}
