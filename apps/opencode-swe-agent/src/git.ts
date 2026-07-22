import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command, capturing output. Never uses a shell (argv array only), so
 * nothing from the caller's instruction or a marker can be interpreted as
 * shell syntax.
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Resolves the committer identity from the token's own GitHub user (via
 * `gh api user`), so commits attribute to the token owner. Best-effort: on
 * failure the caller falls back to a generic identity. This doubles as a
 * lightweight token sanity check (a bad token makes `gh api user` fail).
 */
export async function resolveGitIdentity(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitIdentity | null> {
  const res = await runCommand("gh", ["api", "user"], { env, signal });
  if (res.code !== 0) return null;
  try {
    const user = JSON.parse(res.stdout) as { login?: string; id?: number; name?: string };
    if (!user.login || typeof user.id !== "number") return null;
    return { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  } catch {
    return null;
  }
}

/**
 * Configures git to authenticate to GitHub with the PAT, via a global
 * `insteadOf` rewrite, plus the committer identity. The token lives only in
 * this ephemeral container's HOME/.gitconfig (readable solely by the job's
 * uid). `gh` picks up the same token from the GH_TOKEN environment variable,
 * set by the caller. (GitHub git-over-HTTPS accepts any username with the PAT
 * as the password, so `x-access-token` is fine here.)
 */
export async function setupGitAuth(opts: {
  homeDir: string;
  token: string;
  apiHost: string;
  identity: GitIdentity;
}): Promise<void> {
  const gitconfig = join(opts.homeDir, ".gitconfig");
  const host = opts.apiHost;
  const content =
    `[user]\n` +
    `\tname = ${opts.identity.name}\n` +
    `\temail = ${opts.identity.email}\n` +
    `[url "https://x-access-token:${opts.token}@${host}/"]\n` +
    `\tinsteadOf = https://${host}/\n` +
    `[init]\n` +
    `\tdefaultBranch = main\n` +
    `[safe]\n` +
    `\tdirectory = *\n`;
  await writeFile(gitconfig, content, { mode: 0o600 });
}

export interface CoAuthor {
  login: string;
  /** Numeric GitHub user id — used to build the standard `id+login@users.noreply.github.com` trailer email. */
  id: number;
}

/**
 * Deterministically appends a `Co-authored-by` trailer to the single commit
 * this turn produced, then force-pushes the amended commit — done at the git
 * level in code, not left to the LLM to remember. Only acts when the turn
 * produced EXACTLY one new commit relative to `priorHeadSha` (or, if there
 * was no prior SHA — a brand-new branch/repo — exactly one commit total):
 * a turn that made several commits is left untouched rather than rewriting
 * a longer, organic history non-deterministically. Returns whether the
 * trailer was actually applied.
 */
export async function appendCoAuthorTrailer(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  coAuthor: CoAuthor,
  priorHeadSha: string | null,
): Promise<boolean> {
  const countArgs = priorHeadSha
    ? ["-C", repoDir, "rev-list", "--count", `${priorHeadSha}..HEAD`]
    : ["-C", repoDir, "rev-list", "--count", "HEAD"];
  const countRes = await runCommand("git", countArgs, { env });
  if (countRes.code !== 0 || countRes.stdout.trim() !== "1") return false;

  const msgRes = await runCommand("git", ["-C", repoDir, "log", "-1", "--pretty=%B"], { env });
  if (msgRes.code !== 0) return false;

  const email = `${coAuthor.id}+${coAuthor.login}@users.noreply.github.com`;
  const newMessage = `${msgRes.stdout.trimEnd()}\n\nCo-authored-by: ${coAuthor.login} <${email}>\n`;

  const amendRes = await runCommand("git", ["-C", repoDir, "commit", "--amend", "--allow-empty", "-m", newMessage], {
    env,
  });
  if (amendRes.code !== 0) return false;

  const pushRes = await runCommand("git", ["-C", repoDir, "push", "--force-with-lease"], { env });
  return pushRes.code === 0;
}

/** Ensures a directory exists (recursive, idempotent). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Parses an owner/repo pair out of a git remote URL, stripping any embedded
 * credentials and a trailing `.git`. Pure/testable. Handles both
 * `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`.
 */
export function parseOwnerRepoFromRemote(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = url.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/** Finds the git working tree the agent produced: searches the workdir and its descendants (bounded depth) for a directory containing a `.git` entry. */
export async function findRepoDir(workdir: string, maxDepth = 3): Promise<string | null> {
  let level = [workdir];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level.sort()) {
      if (await hasGit(dir)) return dir;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry === ".git" || entry === "node_modules") continue;
        const candidate = join(dir, entry);
        try {
          if ((await stat(candidate)).isDirectory()) next.push(candidate);
        } catch {
          // ignore unreadable entries
        }
      }
    }
    level = next;
  }
  return null;
}

async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export interface RepoResult {
  repo: string;
  branch: string;
  pr: string | null;
  prUrl: string | null;
}

/**
 * Inspects the produced working tree to discover repo/branch, and asks `gh`
 * for an open PR on that branch. Best-effort: a missing PR is reported as
 * null rather than failing.
 */
export async function discoverResult(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<RepoResult | null> {
  const remote = await runCommand("git", ["-C", repoDir, "remote", "get-url", "origin"], { env, signal });
  if (remote.code !== 0) return null;
  const repo = parseOwnerRepoFromRemote(remote.stdout);
  if (!repo) return null;

  const branchRes = await runCommand("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { env, signal });
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  if (!branch || branch === "HEAD") return { repo, branch: branch || "", pr: null, prUrl: null };

  const pr = await findOpenPr(repo, branch, env, signal);
  return { repo, branch, pr: pr?.number ?? null, prUrl: pr?.url ?? null };
}

async function findOpenPr(
  repo: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ number: string; url: string } | null> {
  const res = await runCommand(
    "gh",
    ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
    { env, signal },
  );
  if (res.code !== 0) return null;
  try {
    const arr = JSON.parse(res.stdout) as Array<{ number?: number; url?: string }>;
    const first = arr[0];
    if (first && typeof first.number === "number" && typeof first.url === "string") {
      return { number: String(first.number), url: first.url };
    }
  } catch {
    // ignore
  }
  return null;
}
