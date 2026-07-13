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
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Configures git to authenticate to GitHub with the installation token, via a
 * global `insteadOf` rewrite, plus a committer identity for the App bot. The
 * token lives only in this ephemeral container's HOME/.gitconfig (readable
 * solely by the job's uid) and expires in ~1h. `gh` picks up the same token
 * from the GH_TOKEN environment variable, set by the caller.
 */
export async function setupGitAuth(opts: {
  homeDir: string;
  token: string;
  appId: string;
  apiHost: string;
}): Promise<void> {
  const gitconfig = join(opts.homeDir, ".gitconfig");
  const host = opts.apiHost;
  const content =
    `[user]\n` +
    `\tname = copilot-swe[bot]\n` +
    `\temail = ${opts.appId}+copilot-swe[bot]@users.noreply.github.com\n` +
    `[url "https://x-access-token:${opts.token}@${host}/"]\n` +
    `\tinsteadOf = https://${host}/\n` +
    `[init]\n` +
    `\tdefaultBranch = main\n` +
    `[safe]\n` +
    `\tdirectory = *\n`;
  await writeFile(gitconfig, content, { mode: 0o600 });
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

/** Finds the git working tree the agent produced: the workdir itself, else the first immediate subdir with a .git entry. */
export async function findRepoDir(workdir: string): Promise<string | null> {
  if (await hasGit(workdir)) return workdir;
  let entries: string[];
  try {
    entries = await readdir(workdir);
  } catch {
    return null;
  }
  for (const entry of entries.sort()) {
    const candidate = join(workdir, entry);
    try {
      if ((await stat(candidate)).isDirectory() && (await hasGit(candidate))) return candidate;
    } catch {
      // ignore unreadable entries
    }
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
export async function discoverResult(repoDir: string, env: NodeJS.ProcessEnv): Promise<RepoResult | null> {
  const remote = await runCommand("git", ["-C", repoDir, "remote", "get-url", "origin"], { env });
  if (remote.code !== 0) return null;
  const repo = parseOwnerRepoFromRemote(remote.stdout);
  if (!repo) return null;

  const branchRes = await runCommand("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { env });
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  if (!branch || branch === "HEAD") return { repo, branch: branch || "", pr: null, prUrl: null };

  const pr = await findOpenPr(repo, branch, env);
  return { repo, branch, pr: pr?.number ?? null, prUrl: pr?.url ?? null };
}

async function findOpenPr(repo: string, branch: string, env: NodeJS.ProcessEnv): Promise<{ number: string; url: string } | null> {
  const res = await runCommand(
    "gh",
    ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
    { env },
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
