/** Resolved caller identity, forwarded to agent-orchestrator's /invoke as the bearer subject/role context. */
export interface Identity {
  subject: string;
  roles: string[];
}

/**
 * DEV/TEST-GRADE identity mapping: a static allowlist of GitHub logins ->
 * {@link Identity}, configured via `GATEWAY_GITHUB_IDENTITIES`. There is no
 * verification here beyond "GitHub's webhook signature was valid" (checked
 * upstream in webhooks/github.ts) -- this only maps an already-authenticated
 * sender's login to a role.
 *
 * A real deployment should replace this with GitHub-org/team-membership
 * lookups (mirrors the same "open question" the integrations-gateway
 * proposal flags for other channels' identity resolution) -- this class
 * exists so the rest of the gateway can be built/tested against a stable
 * shape now, without inventing unverified trust.
 *
 * Fails closed: an unknown login, or the gateway's own bot login, resolves
 * to `undefined` (no identity, event dropped) rather than a default role.
 */
export class GithubIdentityResolver {
  constructor(
    private readonly identities: ReadonlyMap<string, Identity>,
    private readonly botLogin: string,
  ) {}

  resolve(login: string, isBot: boolean): Identity | undefined {
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
