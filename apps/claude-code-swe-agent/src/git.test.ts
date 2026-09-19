import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countCommitsAheadOfOriginHead, runCommand, setupGitAuth } from "./git.js";

// Real-git integration tests for the "did this turn commit pushable work"
// signal. These reproduce the exact shape that produced a false
// "no open pull request was found" warning: a repo cloned DURING the turn
// (so there was no prior HEAD to diff against) that was only READ, not
// committed to -- e.g. cloned to file a GitHub issue.
describe("countCommitsAheadOfOriginHead", () => {
  // Deterministic identity + no reliance on the host's git config.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  let root: string;
  let workDir: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "git-ahead-test-"));
    const originDir = join(root, "origin");
    workDir = join(root, "work");

    // An origin repo with one commit on a default branch, so a clone sets
    // `origin/HEAD` (the ref this function measures against).
    await runCommand("git", ["init", "-b", "main", originDir], { env });
    await runCommand("git", ["-C", originDir, "commit", "--allow-empty", "-m", "base"], { env });
    await runCommand("git", ["clone", originDir, workDir], { env });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is 0 for a freshly cloned repo the turn only read (HEAD still at origin/HEAD)", async () => {
    expect(await countCommitsAheadOfOriginHead(workDir, env)).toBe(0);
  });

  it("counts commits the turn added past the clone's default-branch tip", async () => {
    await runCommand("git", ["-C", workDir, "checkout", "-b", "feature"], { env });
    await runCommand("git", ["-C", workDir, "commit", "--allow-empty", "-m", "work 1"], { env });
    await runCommand("git", ["-C", workDir, "commit", "--allow-empty", "-m", "work 2"], { env });
    expect(await countCommitsAheadOfOriginHead(workDir, env)).toBe(2);
  });

  it("returns 0 (rather than throwing) when the path is not a git repo", async () => {
    expect(await countCommitsAheadOfOriginHead(root, env)).toBe(0);
  });
});

// Real-git verification of the credential split (ADR 0038). The unit test in
// identityDelegation.test.ts asserts the .gitconfig TEXT; this asserts that
// git itself resolves that text the way the design assumes -- the whole split
// rests on `pushInsteadOf` winning for pushes and `insteadOf` for everything
// else, which is a claim about git's behaviour, not about our string.
//
// `ls-remote --get-url` and `remote get-url --push` are git's own resolvers,
// so this needs no network and no credentials that work.
describe("setupGitAuth read/write URL resolution", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "giturl-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function resolvedUrls(pushToken?: string): Promise<{ fetch: string; push: string }> {
    const home = join(root, pushToken ? "split" : "single");
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    await setupGitAuth({
      homeDir: home,
      token: "user-token",
      pushToken,
      apiHost: "github.com",
      identity: { name: "agent[bot]", email: "1+agent[bot]@users.noreply.github.com" },
    });
    const env = { ...process.env, HOME: home };
    await runCommand("git", ["-C", repo, "init"], { env });
    await runCommand("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"], { env });
    const fetchUrl = await runCommand("git", ["-C", repo, "ls-remote", "--get-url", "origin"], { env });
    const pushUrl = await runCommand("git", ["-C", repo, "remote", "get-url", "--push", "origin"], { env });
    return { fetch: fetchUrl.stdout.trim(), push: pushUrl.stdout.trim() };
  }

  it("sends fetches to the user's token and pushes to the App's", async () => {
    const urls = await resolvedUrls("app-token");
    expect(urls.fetch).toBe("https://x-access-token:user-token@github.com/acme/widgets.git");
    expect(urls.push).toBe("https://x-access-token:app-token@github.com/acme/widgets.git");
  });

  it("sends both to the single token when not delegating", async () => {
    const urls = await resolvedUrls();
    expect(urls.fetch).toBe("https://x-access-token:user-token@github.com/acme/widgets.git");
    expect(urls.push).toBe("https://x-access-token:user-token@github.com/acme/widgets.git");
  });
});
