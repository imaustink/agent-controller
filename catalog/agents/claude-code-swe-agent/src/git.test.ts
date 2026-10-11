import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countCommitsAheadOfOriginHead,
  ensureChangeDeliverable,
  ensurePullRequest,
  isWorkingTreeDirty,
  runCommand,
  setupGitAuth,
} from "./git.js";

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

// FIX 4: the runner owns the deliverable. These use real git against a bare
// origin, so they prove the actual commit/branch/push behaviour, not a mock of
// it. Without ensureChangeDeliverable a change turn's work would only reach the
// remote if the model remembered to run git itself.
describe("ensureChangeDeliverable", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  let root: string;
  let originDir: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "deliverable-"));
    originDir = join(root, "origin.git");
    // A bare origin seeded with one commit on main, so a clone gets origin/HEAD.
    await runCommand("git", ["init", "--bare", "-b", "main", originDir], { env });
    const seed = join(root, "seed");
    await runCommand("git", ["clone", originDir, seed], { env });
    await runCommand("git", ["-C", seed, "commit", "--allow-empty", "-m", "base"], { env });
    await runCommand("git", ["-C", seed, "push", "origin", "main"], { env });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function freshClone(name: string): Promise<string> {
    const dir = join(root, name);
    await runCommand("git", ["clone", originDir, dir], { env });
    return dir;
  }

  /** True when the bare origin has a branch of this name. */
  async function originHasBranch(branch: string): Promise<boolean> {
    const res = await runCommand("git", ["-C", originDir, "rev-parse", "--verify", `refs/heads/${branch}`], { env });
    return res.code === 0;
  }

  it("commits a dirty tree on a feature branch and pushes it to origin", async () => {
    const work = await freshClone("work-feature");
    await runCommand("git", ["-C", work, "checkout", "-b", "feature"], { env });
    writeFileSync(join(work, "new.txt"), "change\n");

    expect(await isWorkingTreeDirty(work, env)).toBe(true);
    const published = await ensureChangeDeliverable(work, env);

    expect(published).toEqual({ branch: "feature", committed: true, pushed: true });
    expect(await isWorkingTreeDirty(work, env)).toBe(false);
    expect(await originHasBranch("feature")).toBe(true);
  });

  it("cuts a feature branch rather than committing onto the default branch", async () => {
    const work = await freshClone("work-on-main");
    writeFileSync(join(work, "new.txt"), "change\n");

    const published = await ensureChangeDeliverable(work, env);

    expect(published.committed).toBe(true);
    expect(published.pushed).toBe(true);
    expect(published.branch).toMatch(/^swe\/auto-/);
    expect(published.branch).not.toBe("main");
    expect(await originHasBranch(published.branch!)).toBe(true);
    // main itself was never committed onto / pushed past its base.
    const mainTip = await runCommand("git", ["-C", originDir, "rev-parse", "main"], { env });
    const baseTip = await runCommand("git", ["-C", work, "rev-parse", "origin/main"], { env });
    expect(mainTip.stdout.trim()).toBe(baseTip.stdout.trim());
  });

  it("reports nothing published for a clean tree still on the default branch", async () => {
    const work = await freshClone("work-clean");
    expect(await ensureChangeDeliverable(work, env)).toEqual({ branch: "main", committed: false, pushed: false });
  });
});

describe("ensurePullRequest", () => {
  const env0: NodeJS.ProcessEnv = { ...process.env };
  let binDir: string;
  let stateFile: string;

  // A fake `gh` on PATH: `pr list` returns [] until `pr create` runs (which
  // touches a state file), then returns a PR -- so ensurePullRequest's
  // list -> create -> list sequence resolves to the created PR.
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "fakegh-"));
    stateFile = join(binDir, "created");
    const gh = join(binDir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env node\n` +
        `const { existsSync, writeFileSync } = require("node:fs");\n` +
        `const args = process.argv.slice(2);\n` +
        `const sub = args[0] === "pr" ? args[1] : "";\n` +
        `if (sub === "list") {\n` +
        `  process.stdout.write(existsSync(${JSON.stringify(stateFile)}) ? JSON.stringify([{ number: 7, url: "https://example.test/pr/7" }]) : "[]");\n` +
        `  process.exit(0);\n` +
        `}\n` +
        `if (sub === "create") {\n` +
        `  writeFileSync(${JSON.stringify(stateFile)}, "1");\n` +
        `  process.stdout.write("https://example.test/pr/7\\n");\n` +
        `  process.exit(0);\n` +
        `}\n` +
        `process.exit(1);\n`,
    );
    chmodSync(gh, 0o755);
    env0.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("opens a PR when none is open yet and returns it", async () => {
    rmSync(stateFile, { force: true });
    const pr = await ensurePullRequest("acme/widgets", "feature", env0);
    expect(pr).toEqual({ number: "7", url: "https://example.test/pr/7" });
  });

  it("returns the existing PR without creating a second one", async () => {
    writeFileSync(stateFile, "1"); // a PR already exists
    const pr = await ensurePullRequest("acme/widgets", "feature", env0);
    expect(pr).toEqual({ number: "7", url: "https://example.test/pr/7" });
  });
});
