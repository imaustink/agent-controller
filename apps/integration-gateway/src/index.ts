import { config } from "./config.js";
import { GithubReplyClient } from "./github-client.js";
import { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { decodeEncryptionKey, RedisIdentityLinkStore } from "./identity-link/store.js";
import { GithubIdentityResolver, loadGithubIdentitiesFromEnv } from "./identity.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { GatewayServer } from "./server.js";

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
  if (!config.orchestratorToken) {
    console.error("GATEWAY_ORCHESTRATOR_TOKEN is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  if (!config.identityLinkToken) {
    console.error("GATEWAY_IDENTITY_LINK_TOKEN is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  if (!config.githubAppClientId) {
    console.error("GITHUB_APP_CLIENT_ID is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  if (!config.identityLinkEncryptionKey) {
    console.error("IDENTITY_LINK_ENCRYPTION_KEY is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  const redisUrl = config.redisUrl;
  if (!redisUrl) {
    console.error("AGENT_REDIS_URL is required (the identity-link store has no in-memory fallback -- account links must be durable)");
    process.exit(EXIT_STARTUP_FAILURE);
    return;
  }

  const identities = loadGithubIdentitiesFromEnv(config.githubIdentities);
  const identityResolver = new GithubIdentityResolver(identities, config.githubBotLogin);

  const orchestratorClient = new OrchestratorClient({
    baseUrl: config.orchestratorUrl,
    token: config.orchestratorToken,
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

  const identityLinkStore = new RedisIdentityLinkStore(redisUrl, decodeEncryptionKey(config.identityLinkEncryptionKey));
  await retryWithBackoff("redis startup check (identity-link store)", () => identityLinkStore.connect(), {
    attempts: 12,
    initialDelayMs: 1_000,
    maxDelayMs: 15_000,
  });
  console.error(`Using Redis identity-link store: ${redisUrl}`);

  const identityLinkLinker = new GithubDeviceFlowLinker({
    clientId: config.githubAppClientId,
    scope: config.deviceFlowScope,
    store: identityLinkStore,
    clientSecret: config.githubAppClientSecret,
    stateSecret: config.identityLinkStateSecret,
    redirectUri: config.githubOauthRedirectUri,
  });

  const server = new GatewayServer({
    githubWebhookSecret: config.githubWebhookSecret,
    identityResolver,
    orchestratorClient,
    githubReplyClient,
    identityLinkLinker,
    identityLinkToken: config.identityLinkToken,
  });

  await server.listen(config.httpPort);
  console.error(`integration-gateway listening on :${config.httpPort}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down integration-gateway...`);
    await server.close();
    await identityLinkStore.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(EXIT_STARTUP_FAILURE);
});
