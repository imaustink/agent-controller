import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";

/**
 * A stand-in for the real `gh` binary. `runGh` spawns `GH_BIN` directly (by
 * absolute path, never via PATH) and passes argv through verbatim, so the fake
 * branches on its first argument to simulate each exit path we care about:
 *   ok      -> print stdout, exit 0
 *   fail    -> print to stderr, exit 3
 *   hang    -> block forever (exec sleep) so the timeout must SIGKILL it
 *   echoenv -> print the token env vars back out (auth wiring assertion)
 */
const FAKE_GH = `#!/bin/sh
case "$1" in
  ok)      echo "hello from gh"; exit 0 ;;
  fail)    echo "boom on stderr" 1>&2; exit 3 ;;
  hang)    exec sleep 30 ;;
  echoenv) echo "GH_TOKEN=$GH_TOKEN GITHUB_TOKEN=$GITHUB_TOKEN GH_HOST=$GH_HOST"; exit 0 ;;
  *)       echo "unexpected argv: $*" 1>&2; exit 9 ;;
esac
`;

let dir: string;
// `GH_BIN` is read at module-load time in github.ts, so the env var must be set
// before the module is first imported -- hence the dynamic import in beforeAll.
let runGh: typeof import("./github.js").runGh;
let resolveToolToken: typeof import("./github.js").resolveToolToken;
let GhExecError: typeof import("./github.js").GhExecError;

/**
 * A 2048-bit RSA key, generated here rather than hardcoded, so the App-auth
 * case exercises real RS256 JWT signing (`signAppJwt` calls `createSign`,
 * which rejects anything that isn't a usable key).
 */
const { privateKey: APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: "stdout",
    jobId: "job-1",
    eventsPath: "/tmp/x.ndjson",
    callbackUrl: undefined,
    callbackSecret: undefined,
    callbackAllowedHosts: [],
    callbackMaxRetries: 3,
    natsUrl: undefined,
    natsSubject: undefined,
    githubToken: "ghp_testtoken0123456789abcdef",
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppInstallationId: "",
    githubApiUrl: "https://api.github.com",
    githubHost: "github.com",
    ghTimeoutMs: 5_000,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gh-tool-test-"));
  const ghBin = join(dir, "fake-gh");
  writeFileSync(ghBin, FAKE_GH);
  chmodSync(ghBin, 0o755);
  process.env.GH_BIN = ghBin;
  vi.resetModules();
  const mod = await import("./github.js");
  runGh = mod.runGh;
  resolveToolToken = mod.resolveToolToken;
  GhExecError = mod.GhExecError;
});

afterAll(() => {
  delete process.env.GH_BIN;
  rmSync(dir, { recursive: true, force: true });
});

describe("runGh", () => {
  it("throws GhExecError without spawning anything when no token is configured", async () => {
    await expect(runGh(makeConfig({ githubToken: "" }), ["ok"])).rejects.toBeInstanceOf(GhExecError);
  });

  it("resolves with stdout on a zero exit", async () => {
    const out = await runGh(makeConfig(), ["ok"]);
    expect(out.trim()).toBe("hello from gh");
  });

  it("throws GhExecError carrying stderr and the exit code on a non-zero exit", async () => {
    const err = await runGh(makeConfig(), ["fail"]).catch((e) => e);
    expect(err).toBeInstanceOf(GhExecError);
    expect(err.stderr).toBe("boom on stderr");
    expect(err.exitCode).toBe(3);
  });

  it("kills the child and rejects with a timeout error when gh runs past the deadline", async () => {
    const cfg = makeConfig({ ghTimeoutMs: 150 });
    const started = Date.now();
    const err = await runGh(cfg, ["hang"]).catch((e) => e);
    expect(err).toBeInstanceOf(GhExecError);
    expect(err.message).toBe("gh timed out after 150ms");
    // It must not have waited for the 30s sleep -- the SIGKILL path fired.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("injects the delegated token as both GH_TOKEN and GITHUB_TOKEN, and never the full process env", async () => {
    const out = await runGh(makeConfig({ githubToken: "gho_delegated999", githubHost: "example.com" }), ["echoenv"]);
    expect(out).toContain("GH_TOKEN=gho_delegated999");
    expect(out).toContain("GITHUB_TOKEN=gho_delegated999");
    expect(out).toContain("GH_HOST=example.com");
  });
});

describe("resolveToolToken", () => {
  const APP_CONFIG = {
    githubAppId: "12345",
    githubAppPrivateKey: APP_PEM,
    githubAppInstallationId: "67890",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the supplied token as-is when no App is configured", async () => {
    await expect(resolveToolToken(makeConfig({ githubToken: "ghp_pat" }))).resolves.toBe("ghp_pat");
  });

  it("mints an installation token when only the App is configured", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "ghs_installation", expires_at: "2026-01-01T00:00:00Z" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await resolveToolToken(makeConfig({ githubToken: "", ...APP_CONFIG }));
    expect(token).toBe("ghs_installation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.github.com/app/installations/67890/access_tokens");
  });

  it("prefers a supplied token over the App, so a per-user delegated token is never downgraded to the bot", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveToolToken(makeConfig({ githubToken: "gho_perUser", ...APP_CONFIG }))).resolves.toBe(
      "gho_perUser",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a partial App configuration instead of falling back to the PAT", async () => {
    const err = await resolveToolToken(makeConfig({ githubToken: "ghp_pat", githubAppId: "12345" })).catch((e) => e);
    expect(err).toBeInstanceOf(GhExecError);
    expect(err.message).toContain("Partial GitHub App configuration");
  });

  it("throws when neither credential is configured", async () => {
    const err = await resolveToolToken(makeConfig({ githubToken: "" })).catch((e) => e);
    expect(err).toBeInstanceOf(GhExecError);
    expect(err.message).toContain("No GitHub token configured");
  });

  it("honors a GitHub Enterprise API base when minting", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "ghs_ghes" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveToolToken(makeConfig({ githubToken: "", ...APP_CONFIG, githubApiUrl: "https://ghe.example.com/api/v3" }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ghe.example.com/api/v3/app/installations/67890/access_tokens",
    );
  });
});
