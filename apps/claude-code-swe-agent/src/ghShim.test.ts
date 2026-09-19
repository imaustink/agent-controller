import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
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

  // A GraphQL query always carries `-f query=...`, so classifying it by body
  // flags would send every read to the write token. It takes the read token
  // instead (a mutation then fails with a permissions error) -- the same
  // fail-safe as an unknown command.
  it("routes gh api graphql to the read credential", () => {
    expect(isWriteInvocation(["api", "graphql", "-f", "query=query { viewer { login } }"])).toBe(false);
    expect(isWriteInvocation(["api", "graphql", "-f", "query=mutation { ... }"])).toBe(false);
    expect(isWriteInvocation(["-R", "acme/widgets", "api", "graphql", "-f", "query=..."])).toBe(false);
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

// The tests above run the shim through `tsx`, which happily loads a `.mjs`
// classifier and never exercises the shape production actually ships:
// `installGhShim` writes an *extensionless* `gh` run by `#!/usr/bin/env node`
// that imports the *compiled* `dist/ghShim.js`. That combination depends on
// Node's automatic ESM detection for extensionless entry points (>=22.7). This
// runs exactly that shape -- plain `node`, extensionless file, compiled `.js`
// classifier -- so a regression in either the artifact or the supported-Node
// floor fails here rather than in production.
describe("the shipped shim artifact", () => {
  // Compile the real classifier to `.js` the way `tsc` ships it, so the shim
  // imports compiled JS under plain `node` (not `.ts` under `tsx`). `git.js` is
  // stubbed only to satisfy the module-load import; the classifier never calls
  // `runCommand`, exactly as `dist/git.js` is present-but-unused on this path.
  async function compiledClassifier(dir: string): Promise<string> {
    const source = await readFile(new URL("ghShim.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: "ghShim.ts",
    });
    await writeFile(join(dir, "ghShim.js"), outputText);
    await writeFile(join(dir, "git.js"), "export function runCommand() {}\n");
    return join(dir, "ghShim.js");
  }

  async function runShim(dir: string, args: string[]): Promise<string> {
    const fakeGh = join(dir, "fake-gh");
    await writeFile(fakeGh, '#!/bin/sh\necho "token=$GH_TOKEN"\n', { mode: 0o700 });
    await chmod(fakeGh, 0o700);
    const classifierUrl = pathToFileURL(await compiledClassifier(dir)).href;
    // Extensionless, exactly like `$SWE_HOME/bin/gh` -- NOT `.mjs`.
    const shimPath = join(dir, "gh");
    await writeFile(shimPath, renderGhShim({ realGhPath: fakeGh, classifierUrl }), { mode: 0o700 });
    await chmod(shimPath, 0o700);
    const res = await runCommand("node", [shimPath, ...args], {
      env: { ...process.env, [GH_READ_TOKEN_ENV]: "user-token", [GH_WRITE_TOKEN_ENV]: "app-token" },
    });
    return res.stdout.trim();
  }

  it("hands a read invocation the user's token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghshim-node-"));
    expect(await runShim(dir, ["repo", "list"])).toBe("token=user-token");
  });

  it("hands a write invocation the App's token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghshim-node-"));
    expect(await runShim(dir, ["pr", "create", "--title", "x"])).toBe("token=app-token");
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
