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
  /** Base URL of agent-orchestrator's consumer-facing invoke API (ADR 0006). */
  orchestratorUrl: string;
  /** Bearer token this gateway authenticates to agent-orchestrator's /invoke as. */
  orchestratorToken: string;
  /** JSON map of `{ "<github-login>": { "subject": "...", "roles": ["..."] } }` -- dev/test-grade fallback, see identity.ts. */
  githubIdentities: string | undefined;
  /** JSON map of `{ "<org>/<team-slug>": ["role", ...] }` -- prod-grade primary identity source, see GithubTeamMembershipResolver in identity.ts. */
  githubTeamRoles: string | undefined;
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
    orchestratorUrl: env.GATEWAY_ORCHESTRATOR_URL ?? "http://agent-orchestrator:8081",
    orchestratorToken: env.GATEWAY_ORCHESTRATOR_TOKEN ?? "",
    githubIdentities: env.GATEWAY_GITHUB_IDENTITIES,
    githubTeamRoles: env.GATEWAY_GITHUB_TEAM_ROLES,
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
  };
}

export const config: AppConfig = loadConfig();
