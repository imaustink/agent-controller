/** Resolved caller identity used to scope direct launch permissions. */
export interface Identity {
  subject: string;
  roles: string[];
}

/**
 * Port for turning a caller-supplied auth token into an {@link Identity}.
 * MUST fail closed: return `undefined` on any verification failure rather
 * than throwing partial/guessed roles.
 */
export interface IdentityResolver {
  resolve(authToken: string): Promise<Identity | undefined>;
}
