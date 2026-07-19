import { jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from "jose";
import type { Identity, IdentityResolver } from "./types.js";

export interface OidcIdentityResolverOptions {
  /** Expected `iss` claim; tokens from any other issuer are rejected. */
  issuer: string;
  /** Expected `aud` claim; omit to skip audience verification. */
  audience: string | undefined;
  /** Dot-path to the roles claim, e.g. `"roles"` or `"realm_access.roles"` (Keycloak). */
  rolesClaim: string;
  /**
   * Key resolver passed straight to `jose.jwtVerify` — inject
   * `createRemoteJWKSet(new URL(jwksUri))` in production,
   * `createLocalJWKSet(jwks)` in tests (no network round-trip).
   */
  jwks: JWTVerifyGetKey;
}

function readClaimPath(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, payload);
}

/**
 * Verifies caller-supplied bearer tokens as signed JWTs against a configured
 * OIDC issuer's JWKS — the "real IdP integration" left as an open question by
 * ADR 0004 (docs/orchestrator.md#open-questions-explicitly-deferred). Works
 * with any standards-compliant OIDC provider (Okta, Auth0, Keycloak, Azure
 * AD, Dex, ...): issuer/audience/JWKS endpoint and the roles-claim path are
 * all configurable, no vendor-specific SDK.
 *
 * Fails closed (returns `undefined`) on any verification failure: bad
 * signature, expired, wrong issuer/audience, or a missing/non-string `sub`
 * claim. A missing or malformed roles claim does NOT fail the whole
 * resolution — it resolves to an authenticated identity with zero roles
 * (roles-based checks downstream then deny everything, same fail-closed
 * outcome without discarding a validly-authenticated caller).
 */
export class OidcIdentityResolver implements IdentityResolver {
  constructor(private readonly opts: OidcIdentityResolverOptions) {}

  async resolve(authToken: string): Promise<Identity | undefined> {
    let payload: Record<string, unknown>;
    try {
      const verifyOptions: JWTVerifyOptions = { issuer: this.opts.issuer };
      if (this.opts.audience) verifyOptions.audience = this.opts.audience;
      ({ payload } = await jwtVerify(authToken, this.opts.jwks, verifyOptions));
    } catch {
      return undefined;
    }

    const subject = payload.sub;
    if (typeof subject !== "string" || subject.length === 0) return undefined;

    const rawRoles = readClaimPath(payload, this.opts.rolesClaim);
    const roles = Array.isArray(rawRoles) ? rawRoles.filter((role): role is string => typeof role === "string") : [];

    return { subject, roles };
  }
}
