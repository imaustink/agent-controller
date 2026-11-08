import type { Identity, IdentityResolver } from "./types.js";

/**
 * Tries a primary resolver first, falling back to a secondary resolver only
 * when the primary fails to resolve an identity for the given token.
 *
 * Built for the case where most callers can present a real, verifiable
 * credential (e.g. an oidc-verified JWT) but at least one caller
 * structurally cannot (e.g. Open WebUI, which only ever sends a static
 * configured string as its bearer token, with no way for it to refresh a
 * short-lived upstream access token itself) -- rather than weakening every
 * caller's verification to the lowest common denominator, the primary
 * resolver stays strict and only the specific tokens registered with the
 * fallback resolver get a pass.
 *
 * Fails closed like both underlying resolvers: `undefined` unless one of
 * them positively resolves the token (ADR 0004).
 */
export class CompositeIdentityResolver implements IdentityResolver {
  constructor(
    private readonly primary: IdentityResolver,
    private readonly fallback: IdentityResolver,
  ) {}

  async resolve(authToken: string): Promise<Identity | undefined> {
    const identity = await this.primary.resolve(authToken);
    if (identity !== undefined) return identity;
    return this.fallback.resolve(authToken);
  }
}
