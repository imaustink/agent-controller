import {
  AuthorizationError,
  fetchCollaboratorPermission,
  fetchGithubUser,
  grantCollaboratorAccess,
  isWritePermission,
  mintInstallationToken,
  resolveDelegatedWriteToken,
  resolveGithubToken,
  type GithubAppCredentials,
} from "@controller-agent/github-app-auth";
import type { AgentToolConfig } from "./config.js";

export { AuthorizationError };

/**
 * The permission ceiling for a review run's GitHub token. `contents: "read"`
 * makes `git push` fail at the credential layer (a guarantee independent of the
 * opencode deny list); `pull_requests`/`issues: "write"` keep the review able to
 * post its findings.
 */
export const REVIEW_TOKEN_PERMISSIONS: Record<string, string> = {
  contents: "read",
  pull_requests: "write",
  issues: "write",
};

function appCredsFrom(config: AgentToolConfig): GithubAppCredentials | null {
  const { githubAppId, githubAppPrivateKey, githubAppInstallationId } = config;
  if (githubAppId && githubAppPrivateKey && githubAppInstallationId) {
    return { appId: githubAppId, privateKey: githubAppPrivateKey, installationId: githubAppInstallationId };
  }
  return null;
}

/**
 * Whether this turn should run the dual-token pattern: a full GitHub App
 * configuration plus a per-user OAuth token (only present when identity-link
 * actually supplied `GITHUB_TOKEN`, signaled by
 * `identityDelegationEnabled` — see ./config.ts and the Helm template's
 * `GITHUB_IDENTITY_DELEGATION` env var).
 */
export function isDelegating(config: AgentToolConfig): boolean {
  return Boolean(config.identityDelegationEnabled && appCredsFrom(config) && config.githubToken);
}

/**
 * The credential for a run that does NOT delegate -- a webhook turn, whose
 * shared subject never carries a per-user token. It is the App's either way;
 * with a verified target repository it is scoped to exactly that repository
 * (the one the webhook's sender was checked on), and when `reviewMode` is set
 * it is minted read-only ({@link REVIEW_TOKEN_PERMISSIONS}, `contents: read`)
 * so a push/merge fails at the credential layer -- a guarantee independent of
 * the opencode deny list, and the backstop the default `ai-review` route
 * (`agentRef: opencode-swe-agent`) runs on.
 *
 * Non-review runs and runs without App creds are unchanged: the App path keeps
 * the installation's default permission set, and a static-PAT run falls back to
 * {@link resolveGithubToken} exactly as before (a PAT's scope is fixed and
 * can't be narrowed per run, so a review there relies on the deny list alone).
 */
export async function resolveUndelegatedToken(
  config: AgentToolConfig,
  reviewMode = false,
  now: number = Date.now(),
): Promise<string> {
  const appCreds = appCredsFrom(config);
  if (appCreds && config.targetRepository) return mintTargetRepositoryToken(config, appCreds, now, reviewMode);
  return resolveGithubToken(config, now);
}

async function mintTargetRepositoryToken(
  config: AgentToolConfig,
  appCreds: GithubAppCredentials,
  now: number,
  reviewMode = false,
): Promise<string> {
  const [owner, name] = config.targetRepository.split("/");
  if (!owner || !name) throw new Error(`Expected AGENT_TARGET_REPOSITORY as "owner/repo", got: ${config.targetRepository}`);
  const { token } = await mintInstallationToken(appCreds, config.githubApiUrl, now, {
    repositories: [name],
    ...(reviewMode ? { permissions: REVIEW_TOKEN_PERMISSIONS } : {}),
  });
  return token;
}

export interface DelegatedAttribution {
  githubLogin: string;
  /**
   * Optional since `resolveDelegatedWriteToken` gained `knownLogin`: when the
   * caller's login is already known the `/user` lookup is skipped, and the id
   * comes only from that lookup. Absent just means the co-author trailer uses
   * the `login@users.noreply.github.com` form instead of `id+login@`.
   *
   * This agent never passes `knownLogin`, so in practice it is still always
   * populated here -- the type widens to match the shared helper.
   */
  githubId?: number;
}

/**
 * Resolves the token to use for this turn's git/gh operations, before
 * running opencode.
 *
 * - `repo` known (a continuation): verifies the user's own token actually
 *   grants write/maintain/admin on it, then mints a token scoped to just
 *   that repo. Throws {@link AuthorizationError} to abort *before* any work
 *   happens if the user lacks access.
 * - `repo` unknown (a fresh task — may or may not turn out to create a new
 *   repo): mints an installation-wide token immediately, since there's
 *   nothing to scope-check yet. The caller MUST call
 *   {@link finalizeDelegatedWrite} once the actual repo is known, to either
 *   grant the user access (if this turn just created it) or retroactively
 *   verify access (if it already existed).
 */
export async function resolveDelegatedToken(
  config: AgentToolConfig,
  repo: string | null,
  reviewMode = false,
  now: number = Date.now(),
): Promise<{ token: string; attribution: DelegatedAttribution }> {
  const appCreds = appCredsFrom(config);
  if (!appCreds) throw new Error("resolveDelegatedToken requires a full GitHub App configuration");

  if (repo) {
    const { token, githubLogin, githubId } = await resolveDelegatedWriteToken({
      userToken: config.githubToken,
      repo,
      githubApiUrl: config.githubApiUrl,
      appCreds,
      ...(reviewMode ? { permissions: REVIEW_TOKEN_PERMISSIONS } : {}),
      now,
    });
    return { token, attribution: { githubLogin, githubId } };
  }

  const { login, id } = await fetchGithubUser(config.githubToken, config.githubApiUrl);
  const { token } = await mintInstallationToken(
    appCreds,
    config.githubApiUrl,
    now,
    reviewMode ? { permissions: REVIEW_TOKEN_PERMISSIONS } : {},
  );
  return { token, attribution: { githubLogin: login, githubId: id } };
}

export type PostFlightOutcome =
  | { kind: "granted" }
  | { kind: "verified" }
  | { kind: "revoke"; reason: string };

/**
 * Called after the turn's actual target repo is discovered, only for the
 * "repo wasn't known up front" path (pre-checked continuations don't need
 * this — their authorization already happened in `resolveDelegatedToken`).
 *
 * Deterministically distinguishes "the bot just created this repo" from
 * "this repo already existed" via GitHub's own `created_at` timestamp, not
 * any LLM's say-so:
 *  - freshly created (created_at >= turnStartedAt) -> grant the initiating
 *    user push access on it (the "bot creates, then grants the human" flow).
 *  - pre-existing -> retroactively verify the user's permission. If
 *    insufficient, the write already happened with more privilege than the
 *    user actually has on that repo — the caller is responsible for
 *    revoking the produced artifact (e.g. closing the PR) and surfacing a
 *    hard failure; this function only detects and reports that, it can't
 *    undo the write itself.
 */
export async function finalizeDelegatedWrite(opts: {
  token: string;
  attribution: DelegatedAttribution;
  repo: string;
  githubApiUrl: string;
  turnStartedAt: number;
  fetchImpl?: typeof fetch;
}): Promise<PostFlightOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [owner, name] = opts.repo.split("/");
  if (!owner || !name) throw new Error(`Expected "owner/repo", got: ${opts.repo}`);

  const res = await fetchImpl(`${opts.githubApiUrl}/repos/${owner}/${name}`, {
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to look up repo metadata: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { created_at?: string };
  const createdAtMs = body.created_at ? Date.parse(body.created_at) : NaN;

  if (Number.isFinite(createdAtMs) && createdAtMs >= opts.turnStartedAt) {
    await grantCollaboratorAccess(
      opts.token,
      owner,
      name,
      opts.attribution.githubLogin,
      opts.githubApiUrl,
      "push",
      fetchImpl,
    );
    return { kind: "granted" };
  }

  const permission = await fetchCollaboratorPermission(
    opts.token,
    owner,
    name,
    opts.attribution.githubLogin,
    opts.githubApiUrl,
    fetchImpl,
  );
  if (isWritePermission(permission)) return { kind: "verified" };
  return {
    kind: "revoke",
    reason: `${opts.attribution.githubLogin} does not have write access to ${opts.repo} (permission: ${permission})`,
  };
}
