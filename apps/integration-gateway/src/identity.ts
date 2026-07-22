import { resolveGithubToken, type GithubAuthConfig } from "@controller-agent/github-app-auth";

/** Resolved caller identity, forwarded to agent-orchestrator's /invoke as the bearer subject/role context. */
export interface Identity {
  subject: string;
  roles: string[];
}

/** The repo a webhook event fired on -- needed by resolvers that check per-repo access (e.g. collaborator permission) rather than org-wide membership. */
export interface RepoContext {
  owner: string;
  repo: string;
}

/** Maps an already-webhook-signature-verified GitHub sender login to a role, or `undefined` to drop the event (fail closed). */
export interface IdentityResolver {
  resolve(login: string, isBot: boolean, repoContext?: RepoContext): Promise<Identity | undefined>;
}

/**
 * DEV/TEST-GRADE identity mapping: a static allowlist of GitHub logins ->
 * {@link Identity}, configured via `GATEWAY_GITHUB_IDENTITIES`. There is no
 * verification here beyond "GitHub's webhook signature was valid" (checked
 * upstream in webhooks/github.ts) -- this only maps an already-authenticated
 * sender's login to a role.
 *
 * Kept around as an explicit override/fallback -- e.g. a service login that
 * isn't and shouldn't be a member of any GitHub team -- behind
 * {@link CompositeGithubIdentityResolver}. {@link GithubTeamMembershipResolver}
 * is the prod-grade primary path: it needs no commit/redeploy to add or
 * remove a person, only an org/team membership change on GitHub's side.
 *
 * Fails closed: an unknown login, or the gateway's own bot login, resolves
 * to `undefined` (no identity, event dropped) rather than a default role.
 */
export class GithubIdentityResolver implements IdentityResolver {
  constructor(
    private readonly identities: ReadonlyMap<string, Identity>,
    private readonly botLogin: string,
  ) {}

  async resolve(login: string, isBot: boolean): Promise<Identity | undefined> {
    if (isBot || (this.botLogin && login === this.botLogin)) return undefined;
    return this.identities.get(login);
  }
}

/**
 * Parses `GATEWAY_GITHUB_IDENTITIES`: JSON object of
 * `{ "<github-login>": { "subject": "...", "roles": ["..."] } }`. Returns an
 * empty map (fail closed) on missing/invalid input.
 */
export function loadGithubIdentitiesFromEnv(raw: string | undefined): ReadonlyMap<string, Identity> {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const map = new Map<string, Identity>();
    for (const [login, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { subject?: unknown }).subject === "string" &&
        Array.isArray((value as { roles?: unknown }).roles)
      ) {
        const roles = (value as { roles: unknown[] }).roles.filter((role): role is string => typeof role === "string");
        map.set(login, { subject: (value as { subject: string }).subject, roles });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Parses `GATEWAY_GITHUB_TEAM_ROLES`: JSON object of
 * `{ "<org>/<team-slug>": ["role", ...] }` -- the roles granted to any
 * *active* member of that GitHub team. Returns an empty map (fail closed,
 * same discipline as {@link loadGithubIdentitiesFromEnv}) on missing/invalid
 * input or malformed entries.
 */
export function loadTeamRolesFromEnv(raw: string | undefined): ReadonlyMap<string, string[]> {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const map = new Map<string, string[]>();
    for (const [orgTeam, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!orgTeam.includes("/") || !Array.isArray(value)) continue;
      const roles = value.filter((role): role is string => typeof role === "string");
      if (roles.length > 0) map.set(orgTeam, roles);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Parses `GATEWAY_GITHUB_COLLABORATOR_ROLES`: JSON object of
 * `{ "<permission-level>": ["role", ...] }`, where `<permission-level>` is
 * one of GitHub's repo permission levels ("admin", "maintain", "write",
 * "triage", "read"). Returns an empty map (fail closed, same discipline as
 * {@link loadTeamRolesFromEnv}) on missing/invalid input or malformed
 * entries.
 */
export function loadPermissionRolesFromEnv(raw: string | undefined): ReadonlyMap<string, string[]> {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const map = new Map<string, string[]>();
    for (const [permission, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!permission || !Array.isArray(value)) continue;
      const roles = value.filter((role): role is string => typeof role === "string");
      if (roles.length > 0) map.set(permission, roles);
    }
    return map;
  } catch {
    return new Map();
  }
}

interface CacheEntry {
  identity: Identity | undefined;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 60 * 1000;

export interface GithubTeamMembershipResolverOptions {
  /** `"<org>/<team-slug>" -> roles` granted to active members of that team. */
  teamRoles: ReadonlyMap<string, string[]>;
  /** Credentials used to call GitHub's team-membership API -- same shape/precedence as {@link GithubReplyClient}'s. */
  authConfig: GithubAuthConfig;
  githubApiUrl: string;
  /** The gateway's own bot login -- never resolved to an identity, mirrors {@link GithubIdentityResolver}. */
  botLogin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a positive (member) result is cached before re-checking GitHub. Default 5 minutes. */
  cacheTtlMs?: number;
  /** How long a negative (not a member of any configured team) result is cached. Default 1 minute -- shorter, so a newly-added person isn't stuck waiting on a long TTL. */
  negativeCacheTtlMs?: number;
}

/**
 * PROD-GRADE identity mapping: resolves a GitHub login's identity by
 * checking active membership in one or more GitHub teams via GitHub's REST
 * API (`GET /orgs/:org/teams/:team_slug/memberships/:username`), rather than
 * a static allowlist that needs a commit+redeploy to add or remove a
 * person -- membership is managed entirely on GitHub's side (org/team admin
 * UI or `gh api`/`gh org` commands), and takes effect on this resolver's
 * next (uncached) lookup.
 *
 * In-memory per-login cache bounds API calls / rate-limit exposure across
 * the many webhook events a single active issue thread can generate; a
 * shorter TTL on negative results means a person just added to a team isn't
 * stuck waiting on the longer positive-result TTL.
 *
 * Fails closed: a bot sender, the gateway's own bot login, an API error, a
 * non-"active" membership state (e.g. "pending" -- invited but not yet
 * accepted), or a login that isn't a member of any configured team all
 * resolve to `undefined`.
 */
export class GithubTeamMembershipResolver implements IdentityResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: GithubTeamMembershipResolverOptions) {}

  async resolve(login: string, isBot: boolean): Promise<Identity | undefined> {
    if (isBot || (this.options.botLogin && login === this.options.botLogin)) return undefined;
    if (this.options.teamRoles.size === 0) return undefined;

    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(login);
    if (cached && cached.expiresAt > now) return cached.identity;

    const identity = await this.lookup(login);
    const ttl = identity ? this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS : this.options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this.cache.set(login, { identity, expiresAt: now + ttl });
    return identity;
  }

  private async lookup(login: string): Promise<Identity | undefined> {
    let token: string;
    try {
      token = await resolveGithubToken(this.options.authConfig);
    } catch (error) {
      console.error(`GithubTeamMembershipResolver: failed to resolve GitHub token: ${String(error)}`);
      return undefined;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const roles = new Set<string>();
    for (const [orgTeam, grantedRoles] of this.options.teamRoles) {
      const [org, teamSlug] = orgTeam.split("/", 2);
      if (!org || !teamSlug) continue;
      if (await this.isActiveMember(fetchImpl, token, org, teamSlug, login)) {
        for (const role of grantedRoles) roles.add(role);
      }
    }
    if (roles.size === 0) return undefined;
    return { subject: login, roles: [...roles] };
  }

  private async isActiveMember(fetchImpl: typeof fetch, token: string, org: string, teamSlug: string, login: string): Promise<boolean> {
    try {
      const res = await fetchImpl(`${this.options.githubApiUrl}/orgs/${org}/teams/${teamSlug}/memberships/${login}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (res.status === 404) return false;
      if (!res.ok) {
        console.error(`GithubTeamMembershipResolver: membership check for ${login} in ${org}/${teamSlug} failed: ${res.status}`);
        return false;
      }
      const body = (await res.json()) as { state?: string };
      return body.state === "active";
    } catch (error) {
      console.error(`GithubTeamMembershipResolver: membership check for ${login} in ${org}/${teamSlug} errored: ${String(error)}`);
      return false;
    }
  }
}

export interface GithubCollaboratorPermissionResolverOptions {
  /** GitHub repo permission level ("admin"|"maintain"|"write"|"triage"|"read") -> granted roles. */
  permissionRoles: ReadonlyMap<string, string[]>;
  /** Credentials used to call GitHub's collaborator-permission API -- same shape/precedence as {@link GithubReplyClient}'s. */
  authConfig: GithubAuthConfig;
  githubApiUrl: string;
  /** The gateway's own bot login -- never resolved to an identity, mirrors {@link GithubIdentityResolver}. */
  botLogin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a positive (has some configured permission) result is cached before re-checking GitHub. Default 5 minutes. */
  cacheTtlMs?: number;
  /** How long a negative result is cached. Default 1 minute -- shorter, so someone just added as a collaborator isn't stuck waiting on a long TTL. */
  negativeCacheTtlMs?: number;
}

/**
 * PROD-GRADE identity mapping for setups with no GitHub Organization to
 * hang teams off of -- e.g. a personal-account repo like
 * `imaustink/agent-controller`, where {@link GithubTeamMembershipResolver}'s
 * org/team API has nothing to query. Resolves a GitHub login's identity by
 * checking its actual collaborator permission on the *specific repo the
 * webhook event fired on* (`GET
 * /repos/:owner/:repo/collaborators/:username/permission`) -- adding or
 * removing a person is a "manage access" change on that repo, no
 * commit/redeploy needed.
 *
 * Requires a {@link RepoContext} (owner/repo) to resolve against; without
 * one this fails closed, since there is no per-repo permission to check.
 *
 * Same cache/fail-closed discipline as {@link GithubTeamMembershipResolver}:
 * a bot sender, the gateway's own bot login, an API error, or a permission
 * level not present in `permissionRoles` all resolve to `undefined`.
 */
export class GithubCollaboratorPermissionResolver implements IdentityResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: GithubCollaboratorPermissionResolverOptions) {}

  async resolve(login: string, isBot: boolean, repoContext?: RepoContext): Promise<Identity | undefined> {
    if (isBot || (this.options.botLogin && login === this.options.botLogin)) return undefined;
    if (!repoContext || this.options.permissionRoles.size === 0) return undefined;

    const cacheKey = `${repoContext.owner}/${repoContext.repo}#${login}`;
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.identity;

    const identity = await this.lookup(login, repoContext);
    const ttl = identity ? this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS : this.options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this.cache.set(cacheKey, { identity, expiresAt: now + ttl });
    return identity;
  }

  private async lookup(login: string, repoContext: RepoContext): Promise<Identity | undefined> {
    let token: string;
    try {
      token = await resolveGithubToken(this.options.authConfig);
    } catch (error) {
      console.error(`GithubCollaboratorPermissionResolver: failed to resolve GitHub token: ${String(error)}`);
      return undefined;
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const { owner, repo } = repoContext;
    try {
      const res = await fetchImpl(`${this.options.githubApiUrl}/repos/${owner}/${repo}/collaborators/${login}/permission`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (res.status === 404) return undefined;
      if (!res.ok) {
        console.error(`GithubCollaboratorPermissionResolver: permission check for ${login} on ${owner}/${repo} failed: ${res.status}`);
        return undefined;
      }
      const body = (await res.json()) as { permission?: string };
      const roles = body.permission ? this.options.permissionRoles.get(body.permission) : undefined;
      if (!roles || roles.length === 0) return undefined;
      return { subject: login, roles };
    } catch (error) {
      console.error(`GithubCollaboratorPermissionResolver: permission check for ${login} on ${owner}/${repo} errored: ${String(error)}`);
      return undefined;
    }
  }
}

/**
 * Tries each configured primary resolver in order (e.g.
 * {@link GithubTeamMembershipResolver} for org-based deployments,
 * {@link GithubCollaboratorPermissionResolver} for personal-account repos --
 * real, no-redeploy-needed verification either way) and returns the first
 * identity granted; falls back to the static {@link GithubIdentityResolver}
 * allowlist only when none of them grant anything -- e.g. a service account
 * that shouldn't be a team member or repo collaborator, or a person
 * mid-migration onto one of the real-verification paths. Naming a login in
 * the static map is never a way to bypass the primaries; it only fires when
 * every primary resolver found nothing.
 */
export class CompositeGithubIdentityResolver implements IdentityResolver {
  constructor(
    private readonly primaries: ReadonlyArray<IdentityResolver | undefined>,
    private readonly fallback: GithubIdentityResolver,
  ) {}

  async resolve(login: string, isBot: boolean, repoContext?: RepoContext): Promise<Identity | undefined> {
    for (const primary of this.primaries) {
      const identity = await primary?.resolve(login, isBot, repoContext);
      if (identity) return identity;
    }
    return this.fallback.resolve(login, isBot);
  }
}
