import { config } from "./config.js";
import { GithubReplyClient } from "./github-client.js";
import { GithubIdentityResolver, loadGithubIdentitiesFromEnv } from "./identity.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { GatewayServer } from "./server.js";

const EXIT_STARTUP_FAILURE = 1;

async function main(): Promise<void> {
  if (!config.githubWebhookSecret) {
    console.error("GITHUB_WEBHOOK_SECRET is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  if (!config.orchestratorToken) {
    console.error("GATEWAY_ORCHESTRATOR_TOKEN is required");
    process.exit(EXIT_STARTUP_FAILURE);
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

  const server = new GatewayServer({
    githubWebhookSecret: config.githubWebhookSecret,
    identityResolver,
    orchestratorClient,
    githubReplyClient,
  });

  await server.listen(config.httpPort);
  console.error(`integration-gateway listening on :${config.httpPort}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down integration-gateway...`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(EXIT_STARTUP_FAILURE);
});
