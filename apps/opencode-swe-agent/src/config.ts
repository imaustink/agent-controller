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

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): AgentToolConfig {
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.OPENCODE_MODEL ?? "anthropic/claude-sonnet-5",
    githubApiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    workdir: env.SWE_WORKDIR ?? `/tmp/swe-${randomUUID()}`,
    homeDir: env.SWE_HOME ?? "/tmp/home",
  };
}
