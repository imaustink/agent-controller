import {
  AuthorizationError,
  fetchCollaboratorPermission,
  fetchGithubUser,
  grantCollaboratorAccess,
  isWritePermission,
  mintInstallationToken,
  resolveDelegatedWriteToken,
  type GithubAppCredentials,
} from "@controller-agent/github-app-auth";
import type { AgentToolConfig } from "./config.js";

export { AuthorizationError };

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

export interface DelegatedAttribution {
  githubLogin: string;
  githubId: number;
}

/**
 * Resolves the token to use for this turn's git/gh operations, before
 * running Claude Code.
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
      now,
    });
    return { token, attribution: { githubLogin, githubId } };
  }

  const { login, id } = await fetchGithubUser(config.githubToken, config.githubApiUrl);
  const { token } = await mintInstallationToken(appCreds, config.githubApiUrl, now);
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
