import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GH_READ_TOKEN_ENV, GH_WRITE_TOKEN_ENV, installGhShim, isWriteInvocation, renderGhShim } from "./ghShim.js";
import { runCommand } from "./git.js";

describe("isWriteInvocation", () => {
  it("routes reads to the user's own credential", () => {
    for (const args of [
      ["repo", "list"],
      ["repo", "view", "acme/widgets"],
      ["repo", "clone", "acme/widgets"],
      ["pr", "view", "7"],
      ["pr", "list"],
      ["issue", "list"],
      ["api", "/user/repos"],
      ["api", "repos/acme/widgets"],
    ]) {
      expect(isWriteInvocation(args), args.join(" ")).toBe(false);
    }
  });

  it("routes writes to the App credential", () => {
    for (const args of [
      ["pr", "create", "--title", "x"],
      ["pr", "merge", "7"],
      ["issue", "comment", "7", "--body", "hi"],
      ["repo", "create", "ai-experiments"],
      ["release", "create", "v1"],
      ["secret", "list"], // no subcommand list -> every secret subcommand is privileged
    ]) {
      expect(isWriteInvocation(args), args.join(" ")).toBe(true);
    }
  });

  // `gh -R owner/repo pr create` must not read "owner/repo" as the subcommand.
  it("skips gh's own flags and their values when finding the command", () => {
    expect(isWriteInvocation(["-R", "acme/widgets", "pr", "create"])).toBe(true);
    expect(isWriteInvocation(["-R", "acme/widgets", "pr", "view"])).toBe(false);
    expect(isWriteInvocation(["--repo=acme/widgets", "pr", "create"])).toBe(true);
  });

  it("classifies gh api by method and body flags, not by path", () => {
    expect(isWriteInvocation(["api", "repos/acme/widgets/pulls", "-X", "POST"])).toBe(true);
    expect(isWriteInvocation(["api", "repos/acme/widgets", "--method", "PATCH"])).toBe(true);
    expect(isWriteInvocation(["api", "repos/acme/widgets", "-X", "GET"])).toBe(false);
    expect(isWriteInvocation(["api", "repos/acme/widgets/issues", "-f", "title=x"])).toBe(true);
    expect(isWriteInvocation(["api", "--method=get", "x"])).toBe(false);
  });

  // The table will miss a subcommand eventually. When it does, the invocation
  // must fall to the NARROWER credential and fail, never to the broader one.
  it("defaults an unknown command to the read credential", () => {
    expect(isWriteInvocation(["totally-new-command", "destroy-everything"])).toBe(false);
    expect(isWriteInvocation([])).toBe(false);
  });
});

describe("the generated shim", () => {
  async function shimWith(args: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghshim-"));
    // A stand-in for gh that just reports which token it was handed.
    const fakeGh = join(dir, "fake-gh");
    await writeFile(fakeGh, "#!/bin/sh\necho \"token=$GH_TOKEN\"\n", { mode: 0o700 });
    await chmod(fakeGh, 0o700);

    const classifierUrl = new URL("ghShim.ts", import.meta.url).href;
    const shimPath = join(dir, "gh.mjs");
    await writeFile(shimPath, renderGhShim({ realGhPath: fakeGh, classifierUrl }), { mode: 0o700 });

    const res = await runCommand("npx", ["tsx", shimPath, ...args], {
      env: { ...process.env, [GH_READ_TOKEN_ENV]: "user-token", [GH_WRITE_TOKEN_ENV]: "app-token" },
    });
    return res.stdout.trim();
  }

  it("hands a read invocation the user's token", async () => {
    expect(await shimWith(["repo", "list"])).toBe("token=user-token");
  });

  it("hands a write invocation the App's token", async () => {
    expect(await shimWith(["pr", "create", "--title", "x"])).toBe("token=app-token");
  });

  // Otherwise the agent's own shell could read the other credential straight
  // out of any subprocess environment, making the split cosmetic.
  it("strips both shim variables from what the real gh inherits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghshim-"));
    const fakeGh = join(dir, "fake-gh");
    await writeFile(fakeGh, `#!/bin/sh\necho "read=\${${GH_READ_TOKEN_ENV}:-unset} write=\${${GH_WRITE_TOKEN_ENV}:-unset}"\n`, {
      mode: 0o700,
    });
    await chmod(fakeGh, 0o700);
    const shimPath = join(dir, "gh.mjs");
    await writeFile(shimPath, renderGhShim({ realGhPath: fakeGh, classifierUrl: new URL("ghShim.ts", import.meta.url).href }), {
      mode: 0o700,
    });
    const res = await runCommand("npx", ["tsx", shimPath, "repo", "list"], {
      env: { ...process.env, [GH_READ_TOKEN_ENV]: "user-token", [GH_WRITE_TOKEN_ENV]: "app-token" },
    });
    expect(res.stdout.trim()).toBe("read=unset write=unset");
  });
});

describe("installGhShim", () => {
  it("writes an executable shim and reports its directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "ghhome-"));
    const installed = await installGhShim({ homeDir: home });
    // Skipped rather than failed where gh isn't installed (CI images vary).
    if (!installed) return;
    expect(installed.binDir).toBe(join(home, "bin"));
    const contents = await readFile(join(home, "bin", "gh"), "utf8");
    expect(contents).toContain("isWriteInvocation");
  });
});
