import { randomUUID } from "node:crypto";
import { normalizePem } from "@controller-agent/github-app-auth";

/**
 * Tool-specific configuration for the claude-code-swe-agent. The generic
 * agent runtime config (NATS connection, run id, goal) is handled by
 * `@controller-agent/agent-runtime`'s `loadConfig()` and injected by the Go
 * core-controller into the Job's environment. This only covers the
 * tool-specific settings that are fixed via the Agent CR's `env`/`secretEnv`.
 */
export interface AgentToolConfig {
  /**
   * Fine-grained GitHub PAT used for all git/gh operations (GH_TOKEN).
   * Inject via secretEnv/secretKeyRef. Separate from the Anthropic/Claude
   * credential: the model credential and the git/GitHub credential are two
   * independent secrets.
   */
  githubToken: string;
  /**
   * The caller's GitHub login, resolved by agent-orchestrator's authorization
   * pre-flight and injected as `AGENT_ACTOR_LOGIN` (docs/adr/0030 §5).
   *
   * When set, this agent MUST NOT resolve identity itself. The orchestrator
   * already established who the caller is before launching this run, and the
   * `/user` lookup that used to happen here failed with 401 in production --
   * a call this agent had no reason to make. Empty string means the
   * orchestrator did not supply one (no `github` provider on this Agent), in
   * which case the legacy lookup still applies.
   */
  actorLogin: string;
  /**
   * GitHub App credentials, used instead of `githubToken` when all three are
   * set: a short-lived installation access token is minted per run (see
   * @controller-agent/github-app-auth) rather than using a long-lived static
   * PAT. Empty strings when unset — `resolveGithubToken` falls back to
   * `githubToken` in that case, so existing PAT-based deployments keep
   * working unmodified.
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
   * so commits/PRs attribute to the App bot.
   */
  identityDelegationEnabled: boolean;
  /**
   * Anthropic API key, used when no `claudeCodeOAuthToken` is present.
   * Inject via secretEnv/secretKeyRef.
   */
  anthropicApiKey: string;
  /**
   * A long-lived Claude Code OAuth token (from `claude setup-token`),
   * authenticating as a Claude subscription/Enterprise seat rather than
   * metered API-key billing. Preferred over `anthropicApiKey` when present
   * (the Claude Code CLI itself prefers this once both are set). May be a
   * static secretEnv value or a per-run delegated value (see
   * ./identityDelegation.ts) — this config has no opinion on which.
   */
  claudeCodeOAuthToken: string;
  /** Claude Code model id/alias, e.g. "sonnet" or "claude-sonnet-5". Defaults to the CLI's own default when unset. */
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
   * Writable HOME for git/gh credential files and Claude Code's own config
   * dir. Also under /tmp for the same reason as workdir.
   */
  homeDir: string;
  /**
   * When true, run turns via `claude --bg --remote-control` (see
   * claude-runner.ts's `runClaudeTurnRemoteControlled`) instead of the default
   * one-shot `claude -p`. Requires a separate Go/Helm phase's init container
   * to have already seeded `$SWE_HOME/.claude/.credentials.json` before this
   * process starts -- this flag alone does not provision credentials, it only
   * selects which invocation shape to use.
   */
  remoteControlEnabled: boolean;
  /**
   * How long a Remote Control session may produce NO transcript activity
   * before its turn is given up on (`0`/unset uses claude-runner.ts's
   * default). An operational setting rather than an internal detail for the
   * same reason `AGENT_REPLY_ACK_TIMEOUT_MS` is (ADR 0033): getting it wrong
   * either strands a wedged pod or kills healthy work, and neither should
   * need a rebuild to correct.
   */
  remoteControlIdleTimeoutMs: number;
  /**
   * How long a Remote Control session reporting `status: "idle"` may stay that
   * way before its turn is given up on (`0`/unset uses the default). Much
   * shorter than the silence bound above, because the session is not being
   * quiet -- it is reporting that it is not working.
   */
  remoteControlIdleStatusGraceMs: number;
  /**
   * How long a Remote Control session reporting `status: "waiting"` may stay
   * blocked on a prompt before its turn is given up on (`0`/unset uses the
   * default). Sized by human reaction time -- it is the window someone has to
   * take over the session at its claude.ai URL and answer.
   */
  remoteControlWaitingTimeoutMs: number;
  /**
   * Optional ABSOLUTE cap on a Remote Control turn. Unset means no cap: the
   * idle bound above ends a stuck turn and the Job's `activeDeadlineSeconds`
   * is the wall-clock ceiling. Setting this reintroduces the behaviour behind
   * issue #149, so it exists only as an escape hatch.
   */
  remoteControlMaxWaitMs: number;
  /**
   * The `~/.claude/.credentials.json` blob this run was launched with, as
   * injected by agent-orchestrator (`CLAUDE_LOGIN_CREDENTIALS_JSON`, the same
   * value the init container writes to disk). Read here ONLY to tell a
   * refreshed credentials file apart from the untouched original -- see
   * ./credentialsWriteback.ts.
   */
  loginCredentialsJson: string;
  /**
   * Gateway endpoint + per-run grant token for persisting a credentials file
   * the CLI refreshed mid-run (see ./credentialsWriteback.ts). Injected only
   * for a `claude-remote` identity-linked launch; empty strings otherwise,
   * which simply disables write-back.
   */
  credentialsWritebackUrl: string;
  credentialsWritebackToken: string;
}

/**
 * Parses an optional positive-integer env var, yielding `0` ("not set") for
 * anything absent, non-numeric, or non-positive -- so a typo falls back to the
 * documented default rather than silently disabling a bound.
 */
function positiveInt(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): AgentToolConfig {
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    actorLogin: env.AGENT_ACTOR_LOGIN ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: normalizePem(env.GITHUB_APP_PRIVATE_KEY),
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID ?? "",
    githubAppSlug: env.GITHUB_APP_SLUG ?? "",
    identityDelegationEnabled: env.GITHUB_IDENTITY_DELEGATION === "true",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    claudeCodeOAuthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    model: env.CLAUDE_CODE_MODEL ?? "",
    githubApiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    workdir: env.SWE_WORKDIR ?? `/tmp/swe-${randomUUID()}`,
    homeDir: env.SWE_HOME ?? "/tmp/home",
    remoteControlEnabled: env.CLAUDE_REMOTE_CONTROL === "true",
    remoteControlIdleTimeoutMs: positiveInt(env.CLAUDE_REMOTE_CONTROL_IDLE_TIMEOUT_MS),
    remoteControlIdleStatusGraceMs: positiveInt(env.CLAUDE_REMOTE_CONTROL_IDLE_STATUS_GRACE_MS),
    remoteControlWaitingTimeoutMs: positiveInt(env.CLAUDE_REMOTE_CONTROL_WAITING_TIMEOUT_MS),
    remoteControlMaxWaitMs: positiveInt(env.CLAUDE_REMOTE_CONTROL_MAX_WAIT_MS),
    loginCredentialsJson: env.CLAUDE_LOGIN_CREDENTIALS_JSON ?? "",
    credentialsWritebackUrl: env.CLAUDE_CREDENTIALS_WRITEBACK_URL ?? "",
    credentialsWritebackToken: env.CLAUDE_CREDENTIALS_WRITEBACK_TOKEN ?? "",
  };
}
