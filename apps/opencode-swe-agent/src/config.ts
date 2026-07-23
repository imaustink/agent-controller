import { randomUUID } from "node:crypto";

/**
 * Tool-specific configuration for the opencode-swe-agent. The generic agent
 * runtime config (NATS connection, run id, goal) is handled by
 * `@controller-agent/agent-runtime`'s `loadConfig()` and injected by the Go
 * core-controller into the Job's environment (Phase 7). This only covers the
 * tool-specific settings that are fixed via the Agent CR's `env`/`secretEnv`.
 */
export interface AgentToolConfig {
  /**
   * Fine-grained GitHub PAT used for all git/gh operations (GH_TOKEN).
   * Inject via secretEnv/secretKeyRef. Separate from the Anthropic
   * credential: unlike the old Copilot CLI (which read both the model
   * credential and git/gh auth off one PAT), opencode talks to Anthropic
   * directly so the model credential and the git/GitHub credential are two
   * independent secrets.
   */
  githubToken: string;
  /**
   * GitHub App credentials, used instead of `githubToken` when all three are
   * set: a short-lived installation access token is minted per run (see
   * @controller-agent/github-app-auth) rather than using a long-lived static
   * PAT. Empty strings
   * when unset — `resolveGithubToken` falls back to `githubToken` in that
   * case, so existing PAT-based deployments keep working unmodified.
   */
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: string;
  /**
   * The App's slug (from its GitHub settings page, e.g. "my-cool-app"),
   * public/non-secret. When set alongside `identityDelegationEnabled` and a
   * full App configuration, used to construct the bot's commit identity
   * directly (`${slug}[bot]`) rather than deriving it from a token's own
   * `/user` response — installation tokens can't call `/user` (403, App
   * tokens aren't user tokens), so without this the commit identity falls
   * back to a generic placeholder.
   */
  githubAppSlug: string;
  /**
   * Set when this Agent's identity-link is enabled (i.e. `GITHUB_TOKEN` is
   * the initiating human's own per-run OAuth token, not a shared static
   * credential) AND a full GitHub App configuration is also present — the
   * combination that unlocks the dual-token pattern: verify the human's own
   * access, but write with a freshly minted, repo-scoped installation token
   * so commits/PRs attribute to the App bot. See ./index.ts's `runOneTurn`.
   */
  identityDelegationEnabled: boolean;
  /**
   * Anthropic API key opencode uses to call Claude directly (no GitHub
   * Copilot model proxy involved). Inject via secretEnv/secretKeyRef.
   */
  anthropicApiKey: string;
  /** opencode model id in `provider/model` form, defaults to Sonnet 5 via Anthropic. */
  model: string;
  /** GitHub API base URL; defaults to https://api.github.com. */
  githubApiUrl: string;
  /**
   * Writable workspace root. Under the hardened securityContext
   * (readOnlyRootFilesystem=true) this MUST be under /tmp which is mounted as
   * an emptyDir by the core-controller.
   */
  workdir: string;
  /**
   * Writable HOME for git/gh credential files and opencode's config/data
   * dirs (XDG_CONFIG_HOME/XDG_DATA_HOME are pointed under here too). Also
   * under /tmp for the same reason as workdir.
   */
  homeDir: string;
}

/**
 * k8s Secret values often store multi-line PEM keys with literal `\n`
 * escapes rather than real newlines (depends how the Secret was created);
 * normalize both forms so `createSign(...).sign(privateKeyPem)` gets valid
 * PEM either way.
 */
function normalizePem(value: string | undefined): string {
  if (!value) return "";
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): AgentToolConfig {
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: normalizePem(env.GITHUB_APP_PRIVATE_KEY),
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID ?? "",
    githubAppSlug: env.GITHUB_APP_SLUG ?? "",
    identityDelegationEnabled: env.GITHUB_IDENTITY_DELEGATION === "true",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.OPENCODE_MODEL ?? "anthropic/claude-sonnet-5",
    githubApiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    workdir: env.SWE_WORKDIR ?? `/tmp/swe-${randomUUID()}`,
    homeDir: env.SWE_HOME ?? "/tmp/home",
  };
}
