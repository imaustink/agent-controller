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
  /**
   * Base URL of GitHub's **web/OAuth** host -- where the device-flow and
   * authorization-code endpoints live (`/login/device/code`,
   * `/login/oauth/access_token`). Distinct from `githubApiUrl`: on GitHub
   * Enterprise Server the REST API lives at `https://<host>/api/v3` while
   * these OAuth routes stay on `https://<host>`, so one value cannot serve
   * both. Defaults to github.com, matching `@controller-agent/github-app-auth`'s
   * own default, so existing deployments are unaffected.
   */
  githubBaseUrl: string;
  /**
   * Shared secret used to sign the sender assertion sent to agent-orchestrator
   * (docs/adr/0030 §6). Must match the orchestrator's own
   * AGENT_SENDER_ASSERTION_SECRET. Empty disables signing, in which case the
   * orchestrator falls back to trusting the unsigned `event.senderLogin`.
   */
  senderAssertionSecret: string;
  /** The App/bot's own GitHub login -- events authored by it are ignored (loop prevention). */
  githubBotLogin: string;
  /**
   * The label that triggers automated triage (ADR 0024), on either a GitHub
   * issue (`issues.labeled` -- investigate and open a PR) or a pull request
   * (`pull_request.labeled` -- address the feedback on it, push updates, sync
   * with its base branch). One label for both: "triage this" is the same
   * request either way, and which work it means is fully determined by what
   * was labeled. Not an assignee: GitHub App bot users generally cannot be
   * set as issue assignees (only a small GitHub-owned allowlist, e.g.
   * `dependabot[bot]`, gets that special-cased), so `issues.labeled` is used
   * instead of `issues.assigned`.
   */
  githubTriggerLabel: string;
  /**
   * The label that triggers an automated PR review when applied to a pull
   * request (a `pull_request.labeled` event). Sibling to
   * `githubTriggerLabel`: a distinct label, so requesting a read-only review
   * of a PR stays separate from asking triage to change it. Same identity
   * gate applies -- the review runs
   * as whoever applied the label, so the gateway's bot loop-guard means the
   * label must be applied by a human, not the agent that opened the PR. Empty
   * string disables the trigger (no label name can ever match).
   */
  githubReviewLabel: string;
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
  /**
   * Maximum time (ms) to hold a PARKED turn open waiting for the user to finish
   * linking their account, before giving up and letting them re-trigger.
   *
   * Separate from `pollTimeoutMs`, and much longer by default, because it is
   * bounded by human reaction time rather than by machine latency -- it matches
   * the link flow's own ~10-minute expiry.
   *
   * Configurable because it was not, and a hard-coded 10 minutes is an
   * occupancy decision an operator should own: each parked turn holds a relay
   * for the whole window. In the e2e environment that is acute -- the
   * identity-keying negative controls park on purpose, so a 10-minute hold
   * outlives the spec that caused it and starves whatever triggers next.
   */
  resumeWaitMs: number;
  /**
   * Off switch for refreshing a stored Remote Control (`login`) credential
   * before serving it (claude-auth/credential-refresher.ts). On by default;
   * `false` restores the behaviour where only a run's own in-pod CLI ever
   * refreshed, which made a link's survival depend on every pod reporting its
   * refresh back.
   */
  claudeCredentialRefreshEnabled: boolean;
  /** How close to expiry a stored credential must be before it is refreshed on read. */
  claudeCredentialRefreshMarginMs: number;
  /** Public GitHub App client id used to start OAuth Device Flow links (not a secret). */
  githubAppClientId: string;
  /** Base64 (or hex) 32-byte AES-256-GCM key used to encrypt linked GitHub tokens at rest. */
  identityLinkEncryptionKey: string;
  /** Bearer token agent-orchestrator authenticates to this gateway's /identity-link/* API as (opposite direction from orchestratorToken). */
  identityLinkToken: string;
  /**
   * Namespace the credential Secrets (identity links, Claude credentials,
   * write-back grants) are stored in -- docs/adr/0034.
   *
   * Populated from the downward API (`POD_NAMESPACE`) so it is simply this
   * gateway's own namespace, which is the only one its RBAC Role grants access
   * to. `GATEWAY_CREDENTIAL_NAMESPACE` overrides it for a deployment that keeps
   * credentials elsewhere (and grants the Role there instead).
   */
  credentialNamespace: string;
  /**
   * Redis connection string for the session-page store; same env var
   * agent-orchestrator uses for its own session store.
   *
   * No longer backs credentials. It used to back all of them, and that is
   * exactly what went wrong: the instance runs with persistence disabled on an
   * emptyDir, so a restart deleted every identity link and Claude credential in
   * the cluster and users who had linked months earlier were asked to link
   * again. Those live in Kubernetes Secrets now (docs/adr/0034); what remains
   * here is cache-shaped state that can afford to be lost.
   */
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
   * turn history) outlives a gateway pod restart. Falls back to `redisUrl` when
   * unset, and to an in-memory store -- fine for single-replica/dev, but lost on
   * restart -- when neither is set.
   *
   * Note that "survives a restart" holds only for the GATEWAY's restart: the
   * Redis this points at in practice has persistence disabled on an emptyDir, so
   * its own restart drops these pages too. Tolerable for a link that degrades to
   * a 404 (unlike a credential, which is why those moved to Secrets in
   * docs/adr/0034) but worth fixing separately.
   */
  sessionPageRedisUrl: string | undefined;
  /**
   * Enables the per-user Claude Code OAuth `setup-token` flow (docs/adr/0027)
   * -- opt-in via its own flag (unlike identity-link/session-page, which turn
   * on automatically once their required fields are set) because it also
   * requires the `claude` CLI binary to actually be present in this
   * container image, a real build-time dependency, not just config. Reuses
   * identity-link's encryption-key/bearer-token config and the session-page
   * `publicUrl` -- fails startup if enabled without all of those also being
   * configured (see index.ts).
   */
  claudeAuthEnabled: boolean;
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
    githubBaseUrl: env.GITHUB_BASE_URL ?? "https://github.com",
    senderAssertionSecret: env.GATEWAY_SENDER_ASSERTION_SECRET ?? "",
    githubBotLogin: env.GATEWAY_GITHUB_BOT_LOGIN ?? "",
    githubTriggerLabel: env.GATEWAY_GITHUB_TRIGGER_LABEL ?? "",
    githubReviewLabel: env.GATEWAY_GITHUB_REVIEW_LABEL ?? "",
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
    resumeWaitMs: num(env.GATEWAY_RESUME_WAIT_MS, 10 * 60 * 1000),
    claudeCredentialRefreshEnabled: env.GATEWAY_CLAUDE_CREDENTIAL_REFRESH !== "false",
    claudeCredentialRefreshMarginMs: num(env.GATEWAY_CLAUDE_CREDENTIAL_REFRESH_MARGIN_MS, 30 * 60 * 1000),
    githubAppClientId: env.GITHUB_APP_CLIENT_ID ?? "",
    identityLinkEncryptionKey: env.IDENTITY_LINK_ENCRYPTION_KEY ?? "",
    identityLinkToken: env.GATEWAY_IDENTITY_LINK_TOKEN ?? "",
    credentialNamespace: env.GATEWAY_CREDENTIAL_NAMESPACE ?? env.POD_NAMESPACE ?? "default",
    redisUrl: env.AGENT_REDIS_URL,
    deviceFlowScope: env.GITHUB_DEVICE_FLOW_SCOPE ?? "repo",
    githubAppClientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
    identityLinkStateSecret: env.IDENTITY_LINK_STATE_SECRET ?? "",
    githubOauthRedirectUri: env.GITHUB_OAUTH_REDIRECT_URI ?? "",
    publicUrl: env.GATEWAY_PUBLIC_URL ?? "",
    sessionPageRedisUrl: env.SESSION_PAGE_REDIS_URL,
    claudeAuthEnabled: env.GATEWAY_CLAUDE_AUTH_ENABLED === "true",
  };
}

export const config: AppConfig = loadConfig();
