/**
 * OAuth provider configuration for the identity-link flows.
 *
 * `IdentityProvider` CRs already model `flow: oauth` as the generic extension
 * point — its doc comment says a new OAuth provider "needs no
 * agent-orchestrator code change at all, just a new CR" (docs/adr/0027). That
 * was true of the orchestrator and not of this gateway, where the provider set
 * was the literal `new Set(["github"])`. This module is the missing half: the
 * per-provider data those CRs assume exists.
 *
 * Two OAuth shapes are needed, not one:
 *
 *   - **device** — GitHub's Device Flow. The user is shown a code, the gateway
 *     polls. No redirect URI, so it works for a user who never leaves chat.
 *   - **authcode** — Atlassian 3LO, and what most providers offer. The user is
 *     redirected to the provider and back to `/identity-link/:provider/callback`
 *     with a `state` this gateway minted.
 *
 * Credentials are read from the environment, never from a CR: a client secret
 * belongs in a Secret mount, and putting it in a CR would make the catalog a
 * place secrets live.
 */

export type OAuthFlowKind = "device" | "authcode";

export interface OAuthProviderConfig {
  /** Provider name, matching the `IdentityProvider` CR's `metadata.name`. */
  name: string;
  kind: OAuthFlowKind;
  clientId: string;
  /** Absent for device flow, which has no client secret. */
  clientSecret?: string;
  /** Where the user is sent to approve. */
  authorizeUrl: string;
  /** Where a code (or device code) is exchanged for tokens. */
  tokenUrl: string;
  scopes: string[];
  /**
   * Extra query parameters the provider requires on the authorization URL,
   * beyond the standard `client_id`/`redirect_uri`/`scope`/`state`/`response_type`.
   *
   * Atlassian 3LO needs `audience=api.atlassian.com` here: without it
   * `auth.atlassian.com/authorize` rejects the request outright and the link
   * never completes. Absent for providers that need nothing extra.
   */
  authorizeParams?: Record<string, string>;
  /**
   * Whether this provider ROTATES its refresh token on every refresh.
   *
   * Load-bearing rather than informational. When it rotates, the instant the
   * provider returns new tokens the old refresh token is dead, so the new blob
   * is the only living copy of the credential and must be persisted — or
   * complained about loudly — rather than dropped. That is the failure that
   * produced the `claude-remote` re-authorization loop, and it is documented at
   * length in `claude-auth/credential-refresher.ts`. Atlassian rotates.
   */
  rotatesRefreshToken: boolean;
  /**
   * Endpoint returning the linked account's own id, and the JSON field to read
   * it from. Optional: a provider without one simply stores no `accountId`.
   *
   * Recorded for provenance, never for keying — subjects stay whatever the
   * caller already resolved to (docs/adr/0029, and the `accountId` field's own
   * doc comment in `store.ts`).
   */
  identity?: { url: string; field: string };
}

/** GitHub's Device Flow, unchanged — its endpoints and behaviour are what they were. */
function githubConfig(env: NodeJS.ProcessEnv): OAuthProviderConfig | undefined {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return undefined;
  return {
    name: "github",
    kind: "device",
    clientId,
    authorizeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: (env.GITHUB_OAUTH_SCOPES ?? "repo,read:org").split(",").map((s) => s.trim()),
    // GitHub user-to-server tokens without expiry enabled do not rotate; the
    // existing flow has always assumed this.
    rotatesRefreshToken: false,
  };
}

/**
 * Atlassian 3LO, for Confluence-backed knowledge bases (docs/adr/0040).
 *
 * `offline_access` is required or no refresh token is issued at all, and an
 * access token lasts about an hour — which for a corpus people query all day
 * means a link that silently stops working before lunch.
 */
function atlassianConfig(env: NodeJS.ProcessEnv): OAuthProviderConfig | undefined {
  const clientId = env.ATLASSIAN_CLIENT_ID;
  const clientSecret = env.ATLASSIAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  // GRANULAR scopes. The default used to be the classic set, which no longer
  // works at all: Atlassian removed the v1 content endpoints those scopes
  // reach, and they now answer `410 Gone`. A deployment that set the client id
  // and secret without also setting ATLASSIAN_SCOPES would link successfully
  // and then fail every read, which is the worst shape a default can have.
  //
  // Classic and granular cannot be mixed on one app, so overriding this means
  // overriding all of it.
  // `search:confluence` is separate from the read scopes and easy to miss: a
  // token without it reads pages perfectly well and fails every live lookup,
  // which looks like a broken feature rather than a missing permission.
  const scopes = (
    env.ATLASSIAN_SCOPES ??
    "read:page:confluence read:space:confluence read:content-details:confluence " +
      "search:confluence offline_access"
  )
    .split(/[\s,]+/)
    .filter(Boolean);

  return {
    name: "atlassian",
    kind: "authcode",
    clientId,
    clientSecret,
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: scopes.includes("offline_access") ? scopes : [...scopes, "offline_access"],
    // Required by Atlassian 3LO; the authorize endpoint 400s without it.
    authorizeParams: { audience: "api.atlassian.com" },
    rotatesRefreshToken: true,
    identity: { url: "https://api.atlassian.com/me", field: "account_id" },
  };
}

/**
 * Builds the provider registry from the environment.
 *
 * A provider whose credentials are absent is simply not registered, rather than
 * registered-and-broken: an unconfigured provider then 400s at the route the
 * way an unknown one always has, instead of failing deep inside a token
 * exchange with a confusing error.
 */
export function loadOAuthProviders(env: NodeJS.ProcessEnv = process.env): Map<string, OAuthProviderConfig> {
  const registry = new Map<string, OAuthProviderConfig>();
  for (const build of [githubConfig, atlassianConfig]) {
    const config = build(env);
    if (config) registry.set(config.name, config);
  }
  return registry;
}
