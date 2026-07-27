import * as k8s from "@kubernetes/client-node";
import { config } from "./config.js";
import { ClaudeSetupTokenFlows } from "./claude-auth/pty-setup-token.js";
import { ClaudeLoginFlows } from "./claude-auth/pty-login.js";
import { K8sSecretClaudeTokenStore } from "./claude-auth/k8s-secret-store.js";
import { decodeEncryptionKey } from "./credential-store/field-encryption.js";
import type { SecretApiLike, WatchLike } from "./credential-store/secret-record-store.js";
import { GithubReplyClient } from "./github-client.js";
import { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { K8sSecretIdentityLinkStore } from "./identity-link/k8s-secret-store.js";
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

// A local `retryWithBackoff` lived here to hold startup until the credential
// stores' Redis connections came up. Both stores are Secret-backed now
// (docs/adr/0034) and hold no connection to establish -- each call is a request
// against the API server, retried by the client and degraded per-call by the
// store -- so there is nothing left to wait for at boot.

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
  //
  // `AGENT_REDIS_URL` is deliberately NOT among these any more: linked
  // credentials live in Kubernetes Secrets as of docs/adr/0034, so requiring a
  // Redis URL to enable identity-link would demand a dependency the feature no
  // longer has. Redis remains required only by the session-page store below.
  const identityLinkFields = {
    GATEWAY_IDENTITY_LINK_TOKEN: config.identityLinkToken,
    GITHUB_APP_CLIENT_ID: config.githubAppClientId,
    IDENTITY_LINK_ENCRYPTION_KEY: config.identityLinkEncryptionKey,
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
    senderAssertionSecret: config.senderAssertionSecret,
  });
  if (!config.senderAssertionSecret) {
    console.error(
      "WARNING: GATEWAY_SENDER_ASSERTION_SECRET is not set -- the sender login is relayed to agent-orchestrator UNSIGNED. " +
        "That login selects the caller's principal and therefore which stored credentials a run receives, so anything " +
        "holding this gateway's /invoke token could name an arbitrary login. Set it (and the orchestrator's matching " +
        "AGENT_SENDER_ASSERTION_SECRET) to have the orchestrator require a verified assertion (docs/adr/0030).",
    );
  }

  const githubReplyClient = new GithubReplyClient({
    githubToken: config.githubToken,
    githubAppId: config.githubAppId,
    githubAppPrivateKey: config.githubAppPrivateKey,
    githubAppInstallationId: config.githubAppInstallationId,
    githubApiUrl: config.githubApiUrl,
  });

  /**
   * The in-cluster Kubernetes client backing every credential store
   * (docs/adr/0034). Built once, lazily, so a deployment with neither
   * identity-link nor claude-auth enabled never needs a ServiceAccount token or
   * the RBAC Role -- and so `loadFromCluster` throwing outside a cluster
   * surfaces as a startup failure of the feature that asked for it, naming what
   * is missing, rather than an import-time crash.
   */
  let credentialApis: { api: SecretApiLike; watch: WatchLike } | undefined;
  const credentialStoreApis = (): { api: SecretApiLike; watch: WatchLike } => {
    if (credentialApis) return credentialApis;
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromDefault();
    credentialApis = {
      api: kubeConfig.makeApiClient(k8s.CoreV1Api) as unknown as SecretApiLike,
      watch: new k8s.Watch(kubeConfig) as unknown as WatchLike,
    };
    return credentialApis;
  };

  let identityLinkStore: K8sSecretIdentityLinkStore | undefined;
  let identityLinkLinker: GithubDeviceFlowLinker | undefined;
  if (identityLinkEnabled) {
    identityLinkStore = new K8sSecretIdentityLinkStore(decodeEncryptionKey(config.identityLinkEncryptionKey), {
      namespace: config.credentialNamespace,
      ...credentialStoreApis(),
    });
    console.error(
      `Using Kubernetes Secret identity-link store in namespace ${config.credentialNamespace} (durable across restarts, docs/adr/0034)`,
    );

    identityLinkLinker = new GithubDeviceFlowLinker({
      clientId: config.githubAppClientId,
      scope: config.deviceFlowScope,
      store: identityLinkStore,
      clientSecret: config.githubAppClientSecret,
      stateSecret: config.identityLinkStateSecret,
      redirectUri: config.githubOauthRedirectUri,
      // Without this the linker falls back to its own github.com default,
      // so a GitHub Enterprise Server deployment would send its users to
      // github.com/login/device/code -- which 404s for a GHES-registered
      // App's client id.
      githubBaseUrl: config.githubBaseUrl,
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
      "GATEWAY_CLAUDE_AUTH_ENABLED=true requires identity-link (GATEWAY_IDENTITY_LINK_TOKEN/GITHUB_APP_CLIENT_ID/IDENTITY_LINK_ENCRYPTION_KEY) and GATEWAY_PUBLIC_URL to also be configured",
    );
    process.exit(EXIT_STARTUP_FAILURE);
  }
  let claudeTokenStore: K8sSecretClaudeTokenStore | undefined;
  let claudeAuthFlows: ClaudeSetupTokenFlows | undefined;
  let claudeLoginFlows: ClaudeLoginFlows | undefined;
  if (config.claudeAuthEnabled) {
    claudeTokenStore = new K8sSecretClaudeTokenStore(decodeEncryptionKey(config.identityLinkEncryptionKey), {
      namespace: config.credentialNamespace,
      ...credentialStoreApis(),
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
    resumeWaitMs: config.resumeWaitMs,
  });

  await server.listen(config.httpPort);
  console.error(`integration-gateway listening on :${config.httpPort}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down integration-gateway...`);
    await server.close();
    // The credential stores hold no long-lived connection to close: each call is
    // a request against the API server, and the only durable thing they own is
    // the Secret itself (docs/adr/0034). The Redis handles that used to need
    // draining here went with them.
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
