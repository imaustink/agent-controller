import { mintInstallationToken, type GithubAppCredentials } from "./githubApp.js";

/** Thrown when the user's own token doesn't grant them write access to the target repo — distinct from transport/config failures so callers can render a specific "not authorized" message. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export type CollaboratorPermission = "admin" | "write" | "maintain" | "read" | "triage" | "none";

const WRITE_PERMISSIONS: ReadonlySet<CollaboratorPermission> = new Set(["admin", "write", "maintain"]);

/** Whether `permission` grants enough access to push/commit — the bar for the dual-token authorization check. */
export function isWritePermission(permission: CollaboratorPermission): boolean {
  return WRITE_PERMISSIONS.has(permission);
}

/** Looks up the GitHub login + numeric id for whichever token is passed — a user OAuth token or a PAT. The id is needed to build a precise `id+login@users.noreply.github.com` co-author trailer. */
export async function fetchGithubUser(
  token: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ login: string; id: number }> {
  const res = await fetchImpl(`${apiBaseUrl}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to look up GitHub user: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { login?: string; id?: number };
  if (!body.login || typeof body.id !== "number") throw new Error("GitHub /user response was missing login/id");
  return { login: body.login, id: body.id };
}

/**
 * GitHub's own answer to "what can this user do on this repo" — the
 * authorization signal for the dual-token pattern. Returns "none" (rather
 * than throwing) when the API reports the user has no access at all, since
 * that's an expected, not exceptional, outcome here.
 */
export async function fetchCollaboratorPermission(
  userToken: string,
  owner: string,
  repo: string,
  login: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CollaboratorPermission> {
  const res = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repo}/collaborators/${login}/permission`, {
    headers: { Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return "none";
  if (!res.ok) {
    throw new Error(`Failed to check collaborator permission: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { permission?: CollaboratorPermission };
  return body.permission ?? "none";
}

/** Idempotently grants `login` the given permission on `owner/repo`, using an installation token. */
export async function grantCollaboratorAccess(
  installToken: string,
  owner: string,
  repo: string,
  login: string,
  apiBaseUrl: string,
  permission: "pull" | "triage" | "push" | "maintain" | "admin" = "push",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/repos/${owner}/${repo}/collaborators/${login}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${installToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permission }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to grant collaborator access: ${res.status} ${await res.text()}`);
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Expected "owner/repo", got: ${repo}`);
  return { owner, name };
}

export interface ResolveDelegatedWriteTokenOptions {
  /** The initiating human's own OAuth token, obtained via identity-link — used only for the authorization check, never for the write itself. */
  userToken: string;
  /** "owner/repo" of the target — must already exist (this function is for the continuation/known-repo path; see resolveNewRepoWriteToken for the unknown-repo path). */
  repo: string;
  githubApiUrl: string;
  appCreds: GithubAppCredentials;
  now?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The dual-token authorization+mint step for a known repo: verifies the
 * user's own token actually grants them write/maintain/admin on `repo` via
 * GitHub's own collaborator-permission check, then — only if authorized —
 * mints a fresh installation token scoped to just that repo for the actual
 * write. Throws {@link AuthorizationError} if the user lacks write access;
 * that's the caller's cue to refuse the write entirely rather than fall back
 * to anything.
 */
export async function resolveDelegatedWriteToken(
  opts: ResolveDelegatedWriteTokenOptions,
): Promise<{ token: string; githubLogin: string; githubId: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const { owner, name } = splitRepo(opts.repo);

  const { login, id } = await fetchGithubUser(opts.userToken, opts.githubApiUrl, fetchImpl);
  const permission = await fetchCollaboratorPermission(opts.userToken, owner, name, login, opts.githubApiUrl, fetchImpl);
  if (!isWritePermission(permission)) {
    throw new AuthorizationError(`${login} does not have write access to ${opts.repo} (permission: ${permission})`);
  }

  const { token } = await mintInstallationToken(opts.appCreds, opts.githubApiUrl, now, { repositories: [name] });
  return { token, githubLogin: login, githubId: id };
}
