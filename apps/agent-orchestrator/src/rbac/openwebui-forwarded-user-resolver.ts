import { jwtVerify } from "jose";
import type { Identity, IdentityResolver } from "./types.js";

export interface OpenWebUiForwardedUserResolverOptions {
  /** Shared HS256 secret, matching Open WebUI's `FORWARD_USER_INFO_HEADER_JWT_SECRET`. */
  secret: string;
  /**
   * RBAC roles (this system's own vocabulary, e.g. `["reader", "writer"]` --
   * whatever Tool/Agent CRs declare in `allowedRoles`) granted to every
   * caller this resolver successfully verifies. Open WebUI's own `role`
   * claim ("user"/"admin"/"pending") is Open WebUI's internal permission
   * model, unrelated to this system's RBAC vocabulary -- using it directly
   * as `Identity.roles` (the pre-fix behavior) matches no Tool/Skill's
   * `allowedRoles`, so every catalog lookup for every Open WebUI user comes
   * back empty. This mirrors the fixed roles the old shared static identity
   * (`AGENT_STATIC_IDENTITIES`) granted every user before this resolver
   * existed, just now per-subject instead of per-shared-token.
   */
  roles: string[];
}

/**
 * Resolves identity from Open WebUI's per-request signed `X-OpenWebUI-User-Jwt`
 * header (HS256, minted fresh by Open WebUI on every request when
 * `ENABLE_FORWARD_USER_INFO_HEADERS=true`) rather than the single static
 * bearer token Open WebUI sends on the `Authorization` header.
 *
 * That bearer token is identical for every human using the same Open WebUI
 * deployment, so resolving identity from it (via StaticIdentityResolver)
 * collapses every user into one shared subject -- whoever links an OAuth
 * identity first makes it available to everyone else, with no auth check.
 * This resolver keys off the per-user JWT instead, so each human gets their
 * own subject. The resolved subject is namespaced (`openwebui:<id>`) so it
 * can never collide with a real upstream IdP subject resolved via
 * OidcIdentityResolver.
 *
 * Fails closed like every other resolver (ADR 0004): bad/missing signature,
 * or no usable id claim, returns `undefined` rather than falling back to a
 * shared identity.
 */
export class OpenWebUiForwardedUserResolver implements IdentityResolver {
  private readonly key: Uint8Array;
  private readonly roles: string[];

  constructor(opts: OpenWebUiForwardedUserResolverOptions) {
    this.key = new TextEncoder().encode(opts.secret);
    this.roles = opts.roles;
  }

  async resolve(forwardedUserToken: string): Promise<Identity | undefined> {
    if (!forwardedUserToken) return undefined;

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(forwardedUserToken, this.key, { algorithms: ["HS256"] }));
    } catch {
      return undefined;
    }

    // Open WebUI's forwarded-user JWT payload shape isn't part of any
    // published contract -- accept whichever of these claims is present
    // rather than committing to one exact field name.
    const rawId = payload.id ?? payload.sub ?? payload.email;
    if (typeof rawId !== "string" || rawId.length === 0) return undefined;

    return { subject: `openwebui:${rawId}`, roles: this.roles };
  }
}
