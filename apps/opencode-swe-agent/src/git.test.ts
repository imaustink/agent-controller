import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCoAuthorTrailer, runCommand } from "./git.js";

let workDir: string;
let bareDir: string;
let repoDir: string;

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "swe-git-test-"));
  bareDir = join(workDir, "bare.git");
  repoDir = join(workDir, "repo");
  await git(["init", "--bare", bareDir], workDir);
  await git(["clone", bareDir, repoDir], workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("appendCoAuthorTrailer", () => {
  it("amends the single new commit with a Co-authored-by trailer and pushes it", async () => {
    await git(["commit", "--allow-empty", "-m", "initial"], repoDir);
    await git(["push", "origin", "HEAD:refs/heads/main"], repoDir);
    const priorHeadSha = (await git(["rev-parse", "HEAD"], repoDir)).stdout.trim();

    await git(["commit", "--allow-empty", "-m", "do the thing"], repoDir);

    const applied = await appendCoAuthorTrailer(
      repoDir,
      { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
      { login: "octocat", id: 42 },
      priorHeadSha,
    );

    expect(applied).toBe(true);
    const msg = (await git(["log", "-1", "--pretty=%B"], repoDir)).stdout;
    expect(msg).toContain("do the thing");
    expect(msg).toContain("Co-authored-by: octocat <42+octocat@users.noreply.github.com>");
  });

  it("treats a brand-new repo/branch (no priorHeadSha) with exactly one commit as eligible", async () => {
    await git(["commit", "--allow-empty", "-m", "first commit"], repoDir);
    await git(["push", "origin", "HEAD:refs/heads/main"], repoDir);

    const applied = await appendCoAuthorTrailer(
      repoDir,
      { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
      { login: "octocat", id: 42 },
      null,
    );

    expect(applied).toBe(true);
    const msg = (await git(["log", "-1", "--pretty=%B"], repoDir)).stdout;
    expect(msg).toContain("Co-authored-by: octocat <42+octocat@users.noreply.github.com>");
  });

  it("skips (returns false) when the turn produced more than one new commit", async () => {
    await git(["commit", "--allow-empty", "-m", "initial"], repoDir);
    await git(["push", "origin", "HEAD:refs/heads/main"], repoDir);
    const priorHeadSha = (await git(["rev-parse", "HEAD"], repoDir)).stdout.trim();

    await git(["commit", "--allow-empty", "-m", "commit one"], repoDir);
    await git(["commit", "--allow-empty", "-m", "commit two"], repoDir);

    const applied = await appendCoAuthorTrailer(
      repoDir,
      { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
      { login: "octocat", id: 42 },
      priorHeadSha,
    );

    expect(applied).toBe(false);
    const msg = (await git(["log", "-1", "--pretty=%B"], repoDir)).stdout;
    expect(msg).not.toContain("Co-authored-by");
  });
});
