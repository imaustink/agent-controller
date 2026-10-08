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
  /**
   * The authorize-URL parameter scopes go in. Standard OAuth uses `scope`
   * (the default). Slack is the exception: a USER token — the only kind that can
   * search as the caller — is requested through `user_scope`, and `scope` is
   * reserved for bot scopes this flow never asks for.
   */
  scopeParam?: string;
  /**
   * How the token request is encoded. Standard providers take JSON (the
   * default). Slack's `oauth.v2.access` accepts ONLY
   * `application/x-www-form-urlencoded` and rejects a JSON body.
   */
  tokenRequestEncoding?: "json" | "form";
  /**
   * Read the user token from `authed_user.access_token` rather than the top
   * level. Slack returns the BOT token at the top level and the user token —
   * the one that searches as the caller — nested under `authed_user`.
   */
  userTokenFromAuthedUser?: boolean;
  /**
   * The provider signals failure with HTTP 200 and `{ ok: false, error }` in the
   * body instead of a non-2xx status. Slack does this; without checking it, a
   * failed exchange reads as an empty token rather than an error.
   */
  resultOkInBody?: boolean;
  /**
   * The issued token does not expire, so a missing `expires_in` means
   * "never" rather than "already expired". True for default Slack user tokens
   * (token rotation is opt-in and out of scope here); false everywhere a missing
   * expiry should force a refresh.
   */
  tokensDoNotExpire?: boolean;
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
 * Google, for per-user Drive reads (docs/adr/0040).
 *
 * `drive.readonly` deliberately, and deliberately not narrower: the probe's
 * whole job is to ask what THIS user may open, so a scope narrower than their
 * own view would make it answer a different question and withhold files they
 * can see.
 *
 * `access_type=offline` with `prompt=consent` is what makes a refresh token
 * arrive at all. Google issues one only on the first consent otherwise, so a
 * user who has linked before would re-link into a credential that dies in an
 * hour with nothing to renew it — and the symptom is a knowledge base that
 * works for one turn.
 */
function googleConfig(env: NodeJS.ProcessEnv): OAuthProviderConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  const scopes = (env.GOOGLE_SCOPES ?? "https://www.googleapis.com/auth/drive.readonly")
    .split(/[\s,]+/)
    .filter(Boolean);

  return {
    name: "google",
    kind: "authcode",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes,
    authorizeParams: { access_type: "offline", prompt: "consent" },
    // Google does not rotate: the refresh token issued at consent stays valid
    // until revoked, unlike Atlassian's.
    rotatesRefreshToken: false,
    identity: { url: "https://www.googleapis.com/oauth2/v3/userinfo", field: "sub" },
  };
}

/**
 * Slack, for per-user channel reads (docs/adr/0038, 0040).
 *
 * Slack authorizes at the CHANNEL, so the probe's question is "is this user in
 * the channel", answered by a USER token with `search:read`. Three things make
 * Slack unlike the standard 3LO providers above, and each is carried as a config
 * flag the generic linker honours rather than a Slack fork:
 *
 *   - the user scope is requested through `user_scope`, not `scope`;
 *   - the token exchange is form-encoded (JSON is rejected) and reports failure
 *     as `ok:false` at HTTP 200;
 *   - the user token comes back under `authed_user`, not at the top level.
 *
 * Default Slack user tokens do not expire (token rotation is an opt-in app
 * setting, deliberately out of scope here), so no refresh path is exercised —
 * `rotatesRefreshToken` stays false and `tokensDoNotExpire` keeps a missing
 * `expires_in` from being read as an immediate expiry.
 */
function slackConfig(env: NodeJS.ProcessEnv): OAuthProviderConfig | undefined {
  const clientId = env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  // `search:read` is a USER scope and the only one the probe needs. A narrower
  // or bot-shaped scope would answer a different question than "what may THIS
  // user read", which is the whole point of the delegated path.
  const scopes = (env.SLACK_SCOPES ?? "search:read").split(/[\s,]+/).filter(Boolean);

  return {
    name: "slack",
    kind: "authcode",
    clientId,
    clientSecret,
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes,
    scopeParam: "user_scope",
    tokenRequestEncoding: "form",
    resultOkInBody: true,
    userTokenFromAuthedUser: true,
    rotatesRefreshToken: false,
    tokensDoNotExpire: true,
    identity: { url: "https://slack.com/api/auth.test", field: "user_id" },
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
  for (const build of [githubConfig, atlassianConfig, googleConfig, slackConfig]) {
    const config = build(env);
    if (config) registry.set(config.name, config);
  }
  return registry;
}
