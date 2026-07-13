import { randomUUID } from "node:crypto";

/**
 * Tool-specific configuration for the copilot-swe-agent. The generic agent
 * runtime config (NATS connection, run id, goal) is handled by
 * `@controller-agent/agent-runtime`'s `loadConfig()` and injected by the Go
 * tool-controller into the Job's environment (Phase 7). This only covers the
 * tool-specific settings that are fixed via the Agent CR's `env`/`secretEnv`.
 */
export interface AgentToolConfig {
  /**
   * Fine-grained GitHub PAT used for BOTH the Copilot model (COPILOT_GITHUB_TOKEN)
   * and all git/gh operations (GH_TOKEN). THE secret; inject via secretEnv/secretKeyRef.
   */
  githubToken: string;
  /** Override Copilot model id (e.g. "claude-sonnet-4.6"). Empty = Copilot's default. */
  copilotModel: string;
  /** GitHub API base URL; defaults to https://api.github.com. */
  githubApiUrl: string;
  /**
   * Writable workspace root. Under the hardened securityContext
   * (readOnlyRootFilesystem=true) this MUST be under /tmp which is mounted as
   * an emptyDir by the tool-controller.
   */
  workdir: string;
  /**
   * Writable HOME for git/gh credential files. Also under /tmp for the same
   * reason as workdir.
   */
  homeDir: string;
}

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): AgentToolConfig {
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    copilotModel: env.COPILOT_MODEL ?? "",
    githubApiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    workdir: env.SWE_WORKDIR ?? `/tmp/swe-${randomUUID()}`,
    homeDir: env.SWE_HOME ?? "/tmp/home",
  };
}
