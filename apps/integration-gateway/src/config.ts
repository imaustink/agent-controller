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
  /** JSON map of `{ "<github-login>": { "subject": "...", "roles": ["..."] } }` -- see identity.ts. */
  githubIdentities: string | undefined;
  /** Polling interval (ms) while awaiting a GET /invoke/:id result. */
  pollIntervalMs: number;
  /** Maximum total time (ms) to poll before giving up on a turn. */
  pollTimeoutMs: number;
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
    pollIntervalMs: num(env.GATEWAY_POLL_INTERVAL_MS, 3_000),
    pollTimeoutMs: num(env.GATEWAY_POLL_TIMEOUT_MS, 15 * 60 * 1000),
  };
}

export const config: AppConfig = loadConfig();
