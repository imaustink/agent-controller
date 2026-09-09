import { runCommand } from "./git.js";

/**
 * A repository the agent's GitHub credential can reach, as surfaced to Claude
 * Code in the task prompt (see ./claude.ts's `buildPrompt`). Deliberately a
 * small, prompt-shaped projection of GitHub's repo object — just enough for
 * the model to resolve a partial reference ("my lander-game repo") to a real
 * `owner/name` without spending a turn probing `gh` for it (issue #230).
 */
export interface AccessibleRepo {
  /** "owner/name". */
  fullName: string;
  /** Trimmed one-line description, or null when the repo has none. */
  description: string | null;
  /** "public" or "private" when known, else null. */
  visibility: string | null;
  /** Default branch name (e.g. "main") when known, else null. */
  defaultBranch: string | null;
}

/**
 * Upper bound on how many repositories are spelled out in the prompt. The
 * enumeration is already capped at one `per_page=100` page per endpoint (no
 * `--paginate`), so this only matters for an installation/user with 100
 * accessible repos; beyond it the list is truncated with a note rather than
 * flooding the model's context.
 */
export const MAX_LISTED_REPOS = 100;

/**
 * Parses the JSON body of a GitHub "list repositories" response into
 * {@link AccessibleRepo}s. Pure/testable, and tolerant of both shapes this
 * agent asks for: `GET /installation/repositories` returns
 * `{ total_count, repositories: [...] }` (GitHub App installation token),
 * while `GET /user/repos` returns a bare array (user/PAT token). Anything
 * malformed yields `[]` rather than throwing — repo listing is best-effort
 * context, never a reason to fail the turn.
 */
export function parseAccessibleRepos(stdout: string): AccessibleRepo[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { repositories?: unknown }).repositories)
      ? (data as { repositories: unknown[] }).repositories
      : null;
  if (!arr) return [];

  const repos: AccessibleRepo[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const fullName = typeof r.full_name === "string" ? r.full_name : null;
    if (!fullName) continue;
    const description = typeof r.description === "string" && r.description.trim() ? r.description.trim() : null;
    const visibility =
      typeof r.visibility === "string"
        ? r.visibility
        : r.private === true
          ? "private"
          : r.private === false
            ? "public"
            : null;
    const defaultBranch = typeof r.default_branch === "string" ? r.default_branch : null;
    repos.push({ fullName, description, visibility, defaultBranch });
  }
  return repos;
}

/**
 * Enumerates the repositories the container's GitHub credential can reach, so
 * the prompt can hand Claude Code that list up front instead of the model
 * discovering it turn-by-turn (issue #230).
 *
 * Best-effort by design: any failure (no `gh`, a revoked token, a network
 * error, an endpoint the token type can't call) yields `[]` and the prompt
 * simply omits the section. Tries the GitHub App installation endpoint first
 * — it's what a shared-installation-token deployment is authenticated as —
 * and falls back to `/user/repos` for a user/PAT token, which 403s on
 * `/installation/repositories`. The first endpoint that returns a non-empty
 * list wins; results are de-duplicated and sorted by `full_name` for a stable
 * prompt. Bounded to a single 100-item page per endpoint to keep both the API
 * cost and the prompt size predictable.
 */
export async function listAccessibleRepos(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<AccessibleRepo[]> {
  const endpoints = [
    "/installation/repositories?per_page=100",
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  ];
  for (const endpoint of endpoints) {
    const res = await runCommand("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], { env, signal });
    if (res.code !== 0) continue;
    const repos = parseAccessibleRepos(res.stdout);
    if (repos.length > 0) return sortAndDedupe(repos);
  }
  return [];
}

function sortAndDedupe(repos: AccessibleRepo[]): AccessibleRepo[] {
  const byName = new Map<string, AccessibleRepo>();
  for (const repo of repos) {
    if (!byName.has(repo.fullName)) byName.set(repo.fullName, repo);
  }
  return [...byName.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}
