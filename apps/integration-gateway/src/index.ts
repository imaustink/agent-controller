import { config } from "./config.js";
import { ClaudeSetupTokenFlows } from "./claude-auth/pty-setup-token.js";
import { ClaudeLoginFlows } from "./claude-auth/pty-login.js";
import { RedisClaudeTokenStore } from "./claude-auth/store.js";
import { GithubReplyClient } from "./github-client.js";
import { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { decodeEncryptionKey, RedisIdentityLinkStore } from "./identity-link/store.js";
import {
  CompositeGithubIdentityResolver,
  GithubCollaboratorPermissionResolver,
  GithubIdentityResolver,
  GithubTeamMembershipResolver,
  loadGithubIdentitiesFromEnv,
  loadPermissionRolesFromEnv,
  loadTeamRolesFromEnv,
} from "./identity.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { OidcTokenProvider } from "./oidc-token-provider.js";
import { GatewayServer } from "./server.js";
import { InMemorySessionPageStore, RedisSessionPageStore } from "./session-page-store.js";

const EXIT_STARTUP_FAILURE = 1;

/** Same shape as agent-orchestrator's own startup retry (src/retry.ts) -- kept local since this is a standalone package. */
async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  options: { attempts: number; initialDelayMs: number; maxDelayMs: number },
): Promise<T> {
  let delayMs = options.initialDelayMs;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === options.attempts) break;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${label} failed (attempt ${attempt}/${options.attempts}): ${reason} -- retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, options.maxDelayMs);
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  if (!config.githubWebhookSecret) {
    console.error("GITHUB_WEBHOOK_SECRET is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  // OIDC client_credentials fields (automatic token fetch/refresh) are an
  // opt-in alternative to the static GATEWAY_ORCHESTRATOR_TOKEN -- same
  // partial-config-fails-closed discipline as identity-link below (a typo'd
  // Secret/values file leaving some but not all four set is far more likely
  // than an intentional partial configuration).
  const orchestratorOidcFields = {
    GATEWAY_ORCHESTRATOR_OIDC_TOKEN_ENDPOINT: config.orchestratorOidcTokenEndpoint,
    GATEWAY_ORCHESTRATOR_OIDC_CLIENT_ID: config.orchestratorOidcClientId,
    GATEWAY_ORCHESTRATOR_OIDC_CLIENT_SECRET: config.orchestratorOidcClientSecret,
    GATEWAY_ORCHESTRATOR_OIDC_RESOURCE: config.orchestratorOidcResource,
  };
  const orchestratorOidcFieldEntries = Object.entries(orchestratorOidcFields);
  const orchestratorOidcFieldsSet = orchestratorOidcFieldEntries.filter(([, value]) => Boolean(value));
  if (orchestratorOidcFieldsSet.length > 0 && orchestratorOidcFieldsSet.length < orchestratorOidcFieldEntries.length) {
    const missing = orchestratorOidcFieldEntries.filter(([, value]) => !value).map(([name]) => name);
    console.error(`Partial orchestrator OIDC configuration -- missing: ${missing.join(", ")}`);
    process.exit(EXIT_STARTUP_FAILURE);
  }
  const orchestratorOidcEnabled = orchestratorOidcFieldsSet.length === orchestratorOidcFieldEntries.length;

  if (!orchestratorOidcEnabled && !config.orchestratorToken) {
    console.error(
      "GATEWAY_ORCHESTRATOR_TOKEN is required (or the four GATEWAY_ORCHESTRATOR_OIDC_* fields, for automatic token refresh)",
    );
    process.exit(EXIT_STARTUP_FAILURE);
  }

  // Identity-link (docs/adr/0022) is an opt-in feature (chart's
  // identityLink.enabled), so it must never be unconditionally required --
  // an integration-gateway deployment that doesn't use it (e.g. today's
  // production, which only relays GitHub issue comments) must keep starting
  // with none of these four set. Only fail closed on a PARTIAL
  // configuration (some but not all set), since that's almost certainly a
  // typo'd Secret/values file rather than an intentional choice -- same
  // discipline as opencode-swe-agent's GitHub App fields (ADR 0018).
  const identityLinkFields = {
    GATEWAY_IDENTITY_LINK_TOKEN: config.identityLinkToken,
    GITHUB_APP_CLIENT_ID: config.githubAppClientId,
    IDENTITY_LINK_ENCRYPTION_KEY: config.identityLinkEncryptionKey,
    AGENT_REDIS_URL: config.redisUrl,
  };
  const identityLinkFieldEntries = Object.entries(identityLinkFields);
  const identityLinkFieldsSet = identityLinkFieldEntries.filter(([, value]) => Boolean(value));
  if (identityLinkFieldsSet.length > 0 && identityLinkFieldsSet.length < identityLinkFieldEntries.length) {
    const missing = identityLinkFieldEntries.filter(([, value]) => !value).map(([name]) => name);
    console.error(`Partial identity-link configuration -- missing: ${missing.join(", ")}`);
    process.exit(EXIT_STARTUP_FAILURE);
  }
  const identityLinkEnabled = identityLinkFieldsSet.length === identityLinkFieldEntries.length;

  const identities = loadGithubIdentitiesFromEnv(config.githubIdentities);
  const staticIdentityResolver = new GithubIdentityResolver(identities, config.githubBotLogin);

  // Prod-grade primary identity source (docs/adr's follow-up on the static
  // allowlist): GitHub org/team membership, no commit/redeploy needed to add
  // or remove a person. Only constructed when GATEWAY_GITHUB_TEAM_ROLES is
  // actually set, so a deployment that hasn't migrated yet keeps working off
  // the static allowlist alone.
  const teamRoles = loadTeamRolesFromEnv(config.githubTeamRoles);
  const teamMembershipResolver =
    teamRoles.size > 0
      ? new GithubTeamMembershipResolver({
          teamRoles,
          authConfig: {
            githubToken: config.githubToken,
            githubAppId: config.githubAppId,
            githubAppPrivateKey: config.githubAppPrivateKey,
            githubAppInstallationId: config.githubAppInstallationId,
            githubApiUrl: config.githubApiUrl,
          },
          githubApiUrl: config.githubApiUrl,
          botLogin: config.githubBotLogin,
        })
      : undefined;

  // Same idea, but for personal-account (no-org) repos where team membership
  // has nothing to check against -- grants roles by the sender's actual
  // collaborator permission on the specific repo the webhook fired on.
  const collaboratorRoles = loadPermissionRolesFromEnv(config.githubCollaboratorRoles);
  const collaboratorPermissionResolver =
    collaboratorRoles.size > 0
      ? new GithubCollaboratorPermissionResolver({
          permissionRoles: collaboratorRoles,
          authConfig: {
            githubToken: config.githubToken,
            githubAppId: config.githubAppId,
            githubAppPrivateKey: config.githubAppPrivateKey,
            githubAppInstallationId: config.githubAppInstallationId,
            githubApiUrl: config.githubApiUrl,
          },
          githubApiUrl: config.githubApiUrl,
          botLogin: config.githubBotLogin,
        })
      : undefined;

  const identityResolver = new CompositeGithubIdentityResolver(
    [teamMembershipResolver, collaboratorPermissionResolver],
    staticIdentityResolver,
  );

  // Automatic token fetch/refresh (previously a documented, unbuilt
  // follow-up -- see imaustink/homelab's kubernetes/manifests/agent-controller
  // /README.md's "integration-gateway token refresh (not yet built)" note)
  // when the OIDC fields are configured; otherwise the static token, exactly
  // as before this feature existed.
  const orchestratorTokenProvider = orchestratorOidcEnabled
    ? new OidcTokenProvider({
        tokenEndpoint: config.orchestratorOidcTokenEndpoint!,
        clientId: config.orchestratorOidcClientId!,
        clientSecret: config.orchestratorOidcClientSecret!,
        resource: config.orchestratorOidcResource,
      })
    : undefined;

  const orchestratorClient = new OrchestratorClient({
    baseUrl: config.orchestratorUrl,
    token: orchestratorTokenProvider ? () => orchestratorTokenProvider.getToken() : config.orchestratorToken,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
  });

  const githubReplyClient = new GithubReplyClient({
    githubToken: config.githubToken,
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    githubAppInstallationId: config.githubAppInstallationId,
    githubApiUrl: config.githubApiUrl,
  });

  let identityLinkStore: RedisIdentityLinkStore | undefined;
  let identityLinkLinker: GithubDeviceFlowLinker | undefined;
  if (identityLinkEnabled) {
    const redisUrl = config.redisUrl!;
    identityLinkStore = new RedisIdentityLinkStore(redisUrl, decodeEncryptionKey(config.identityLinkEncryptionKey));
    await retryWithBackoff("redis startup check (identity-link store)", () => identityLinkStore!.connect(), {
      attempts: 12,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
    });
    console.error(`Using Redis identity-link store: ${redisUrl}`);

    identityLinkLinker = new GithubDeviceFlowLinker({
      clientId: config.githubAppClientId,
      scope: config.deviceFlowScope,
      store: identityLinkStore,
      clientSecret: config.githubAppClientSecret,
      stateSecret: config.identityLinkStateSecret,
      redirectUri: config.githubOauthRedirectUri,
    });
  }

  // Session page (issue #81) is opt-in: only enabled once a public base URL
  // is configured, since a page link with nowhere reachable to send it is
  // useless. The Redis-backed store is preferred (survives a pod restart --
  // this link is posted into a GitHub comment and may be revisited days
  // later) but falls back to in-memory, sharing the same
  // "works standalone, better with Redis" posture as elsewhere in this app.
  const sessionPageEnabled = Boolean(config.publicUrl);
  const sessionPageRedisUrl = config.sessionPageRedisUrl ?? config.redisUrl;
  let sessionPageStore: RedisSessionPageStore | InMemorySessionPageStore | undefined;
  if (sessionPageEnabled) {
    sessionPageStore = sessionPageRedisUrl ? new RedisSessionPageStore(sessionPageRedisUrl) : new InMemorySessionPageStore();
    console.error(
      `Session pages enabled at ${config.publicUrl} (${sessionPageRedisUrl ? `Redis: ${sessionPageRedisUrl}` : "in-memory"})`,
    );
  }

  // Claude-auth (docs/adr/0027) is opt-in and layered on top of
  // identity-link's Redis/encryption-key/bearer-token config and
  // session-page's publicUrl -- fail closed (not silently disabled) if
  // enabled without those, since a misconfigured deployment here means every
  // Claude-Code-swe-agent delegation that needs a per-user token silently
  // has nowhere to send the user, not a graceful degradation.
  if (config.claudeAuthEnabled && !(identityLinkEnabled && sessionPageEnabled)) {
    console.error(
      "GATEWAY_CLAUDE_AUTH_ENABLED=true requires identity-link (GATEWAY_IDENTITY_LINK_TOKEN/GITHUB_APP_CLIENT_ID/IDENTITY_LINK_ENCRYPTION_KEY/AGENT_REDIS_URL) and GATEWAY_PUBLIC_URL to also be configured",
    );
    process.exit(EXIT_STARTUP_FAILURE);
  }
  let claudeTokenStore: RedisClaudeTokenStore | undefined;
  let claudeAuthFlows: ClaudeSetupTokenFlows | undefined;
  let claudeLoginFlows: ClaudeLoginFlows | undefined;
  if (config.claudeAuthEnabled) {
    const redisUrl = config.redisUrl!;
    claudeTokenStore = new RedisClaudeTokenStore(redisUrl, decodeEncryptionKey(config.identityLinkEncryptionKey));
    await retryWithBackoff("redis startup check (claude-auth store)", () => claudeTokenStore!.connect(), {
      attempts: 12,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
    });
    claudeAuthFlows = new ClaudeSetupTokenFlows();
    // Same gate as the setup-token flow above -- both need the same `claude`
    // CLI binary in this image and the same PTY mechanics, just a different
    // subcommand/captured payload (docs/adr/0027's "claude-remote" follow-up).
    // Without this, `mode=login` requests 501 forever and no Remote Control
    // credential can ever be created, regardless of anything else being
    // configured correctly downstream.
    claudeLoginFlows = new ClaudeLoginFlows();
    console.error("Claude Code per-user OAuth linking enabled (setup-token + full-login/Remote Control)");
  }

  const server = new GatewayServer({
    githubWebhookSecret: config.githubWebhookSecret,
    identityResolver,
    orchestratorClient,
    githubReplyClient,
    githubTriggerLabel: config.githubTriggerLabel,
    githubReviewLabel: config.githubReviewLabel,
    ...(identityLinkLinker ? { identityLinkLinker, identityLinkToken: config.identityLinkToken } : {}),
    ...(sessionPageStore ? { sessionPageStore, publicBaseUrl: config.publicUrl } : {}),
    ...(claudeAuthFlows && claudeTokenStore ? { claudeAuthFlows, claudeAuthStore: claudeTokenStore } : {}),
    ...(claudeLoginFlows ? { claudeLoginFlows } : {}),
  });

  await server.listen(config.httpPort);
  console.error(`integration-gateway listening on :${config.httpPort}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down integration-gateway...`);
    await server.close();
    await identityLinkStore?.close();
    await claudeTokenStore?.close();
    if (sessionPageStore instanceof RedisSessionPageStore) await sessionPageStore.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(EXIT_STARTUP_FAILURE);
});
