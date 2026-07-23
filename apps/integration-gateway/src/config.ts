/** Central configuration for the GitHub Issues integration gateway. */
export interface AppConfig {
  /** Consumer-facing HTTP port for POST /webhooks/github. */
  httpPort: number;
  /** Shared secret configured on the GitHub webhook/App, used to verify X-Hub-Signature-256. */
  githubWebhookSecret: string;
  /** GitHub App credentials (ADR 0018) used to mint an installation token for posting issue comments. */
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: string;
  /** Fallback static PAT, used only if the App fields above are unset. */
  githubToken: string;
  githubApiUrl: string;
  /** The App/bot's own GitHub login -- events authored by it are ignored (loop prevention). */
  githubBotLogin: string;
  /**
   * The label that triggers automated triage (ADR 0024) when applied to a
   * GitHub issue. Not an assignee: GitHub App bot users generally cannot be
   * set as issue assignees (only a small GitHub-owned allowlist, e.g.
   * `dependabot[bot]`, gets that special-cased), so `issues.labeled` is used
   * instead of `issues.assigned`.
   */
  githubTriggerLabel: string;
  /** Base URL of agent-orchestrator's consumer-facing invoke API (ADR 0006). */
  orchestratorUrl: string;
  /**
   * Static bearer token this gateway authenticates to agent-orchestrator's
   * /invoke as -- only used when the OIDC client_credentials fields below
   * are not configured (see `orchestratorOidc*`). A static token requires
   * manual re-minting whenever it expires; prefer the OIDC fields for any
   * deployment backed by a real client_credentials-capable IdP (e.g. Pocket
   * ID), which fetches/caches/refreshes its own token automatically.
   */
  orchestratorToken: string;
  /** OIDC token endpoint for a client_credentials grant, e.g. `https://pocket-id.example.com/api/oidc/token`. Set together with the three fields below to enable automatic token refresh instead of the static `orchestratorToken`. */
  orchestratorOidcTokenEndpoint: string | undefined;
  orchestratorOidcClientId: string | undefined;
  orchestratorOidcClientSecret: string | undefined;
  /** RFC 8707 `resource` param -- the audience the minted token should be scoped to (agent-orchestrator's own URL). */
  orchestratorOidcResource: string | undefined;
  /** JSON map of `{ "<github-login>": { "subject": "...", "roles": ["..."] } }` -- dev/test-grade fallback, see identity.ts. */
  githubIdentities: string | undefined;
  /** JSON map of `{ "<org>/<team-slug>": ["role", ...] }` -- prod-grade primary identity source for org-based deployments, see GithubTeamMembershipResolver in identity.ts. */
  githubTeamRoles: string | undefined;
  /** JSON map of `{ "<permission-level>": ["role", ...] }` -- prod-grade primary identity source for personal-account (no-org) repos, see GithubCollaboratorPermissionResolver in identity.ts. */
  githubCollaboratorRoles: string | undefined;
  /** Polling interval (ms) while awaiting a GET /invoke/:id result. */
  pollIntervalMs: number;
  /** Maximum total time (ms) to poll before giving up on a turn. */
  pollTimeoutMs: number;
  /** Public GitHub App client id used to start OAuth Device Flow links (not a secret). */
  githubAppClientId: string;
  /** Base64 (or hex) 32-byte AES-256-GCM key used to encrypt linked GitHub tokens at rest. */
  identityLinkEncryptionKey: string;
  /** Bearer token agent-orchestrator authenticates to this gateway's /identity-link/* API as (opposite direction from orchestratorToken). */
  identityLinkToken: string;
  /** Redis connection string backing the durable identity-link store; same env var agent-orchestrator uses for its own session store. */
  redisUrl: string | undefined;
  /** OAuth scope requested when starting a device-flow link. */
  deviceFlowScope: string;
  /** GitHub App client secret; only required when the authcode identity-link flow is actually used. */
  githubAppClientSecret: string;
  /** HMAC secret used to sign/verify the authcode `state` param; only required when the authcode identity-link flow is actually used. */
  identityLinkStateSecret: string;
  /** Must exactly match the GitHub App's registered OAuth callback URL (not a secret); only required when the authcode identity-link flow is actually used. */
  githubOauthRedirectUri: string;
  /**
   * Public base URL this gateway is reachable at (e.g.
   * `https://gateway.example.com`), used to build the session-page link
   * (issue #81) posted alongside the "starting work" comment on an
   * `issues.labeled` triage trigger. Empty disables the whole session-page
   * feature: no page link is ever posted, and `GET /sessions/*` 404s.
   */
  publicUrl: string;
  /**
   * Redis URL backing the session-page store, so a posted page link (and its
   * turn history) survives a gateway pod restart. Falls back to `redisUrl`
   * (the identity-link Redis instance) when unset, and to an in-memory store
   * -- fine for single-replica/dev, but lost on restart -- when neither is set.
   */
  sessionPageRedisUrl: string | undefined;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Normalizes a `\n`-escaped PEM (common in env-var-injected secrets) back into real newlines. */
function normalizePem(raw: string | undefined): string {
  return raw?.includes("\\n") ? raw.replace(/\\n/g, "\n") : (raw ?? "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    httpPort: num(env.GATEWAY_HTTP_PORT, 8090),
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: normalizePem(env.GITHUB_APP_PRIVATE_KEY),
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID ?? "",
    githubToken: env.GITHUB_TOKEN ?? "",
    githubApiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    githubBotLogin: env.GATEWAY_GITHUB_BOT_LOGIN ?? "",
    githubTriggerLabel: env.GATEWAY_GITHUB_TRIGGER_LABEL ?? "",
    orchestratorUrl: env.GATEWAY_ORCHESTRATOR_URL ?? "http://agent-orchestrator:8081",
    orchestratorToken: env.GATEWAY_ORCHESTRATOR_TOKEN ?? "",
    orchestratorOidcTokenEndpoint: env.GATEWAY_ORCHESTRATOR_OIDC_TOKEN_ENDPOINT,
    orchestratorOidcClientId: env.GATEWAY_ORCHESTRATOR_OIDC_CLIENT_ID,
    orchestratorOidcClientSecret: env.GATEWAY_ORCHESTRATOR_OIDC_CLIENT_SECRET,
    orchestratorOidcResource: env.GATEWAY_ORCHESTRATOR_OIDC_RESOURCE,
    githubIdentities: env.GATEWAY_GITHUB_IDENTITIES,
    githubTeamRoles: env.GATEWAY_GITHUB_TEAM_ROLES,
    githubCollaboratorRoles: env.GATEWAY_GITHUB_COLLABORATOR_ROLES,
    pollIntervalMs: num(env.GATEWAY_POLL_INTERVAL_MS, 3_000),
    pollTimeoutMs: num(env.GATEWAY_POLL_TIMEOUT_MS, 15 * 60 * 1000),
    githubAppClientId: env.GITHUB_APP_CLIENT_ID ?? "",
    identityLinkEncryptionKey: env.IDENTITY_LINK_ENCRYPTION_KEY ?? "",
    identityLinkToken: env.GATEWAY_IDENTITY_LINK_TOKEN ?? "",
    redisUrl: env.AGENT_REDIS_URL,
    deviceFlowScope: env.GITHUB_DEVICE_FLOW_SCOPE ?? "repo",
    githubAppClientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
    identityLinkStateSecret: env.IDENTITY_LINK_STATE_SECRET ?? "",
    githubOauthRedirectUri: env.GITHUB_OAUTH_REDIRECT_URI ?? "",
    publicUrl: env.GATEWAY_PUBLIC_URL ?? "",
    sessionPageRedisUrl: env.SESSION_PAGE_REDIS_URL,
  };
}

export const config: AppConfig = loadConfig();
