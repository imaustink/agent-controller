import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `config.ts` materializes a single `config` object from `process.env` at
 * import time, so each case sets the env then re-imports the module fresh via
 * `vi.resetModules()` + dynamic import.
 */
const ENV_KEYS = [
  "RECIPE_TRANSPORT",
  "RECIPE_JOB_ID",
  "RECIPE_EVENTS_PATH",
  "RECIPE_CALLBACK_URL",
  "RECIPE_CALLBACK_ALLOWED_HOSTS",
  "RECIPE_CALLBACK_MAX_RETRIES",
  "RECIPE_NATS_URL",
  "RECIPE_NATS_SUBJECT",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_HOST",
  "GITHUB_TOOL_TIMEOUT_MS",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_API_URL",
];

let saved: Record<string, string | undefined>;

async function loadConfig() {
  vi.resetModules();
  return (await import("./config.js")).config;
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("config", () => {
  it("defaults transport to stdout and applies sensible fallbacks", async () => {
    const config = await loadConfig();
    expect(config.transport).toBe("stdout");
    expect(config.ghTimeoutMs).toBe(30_000);
    expect(config.callbackMaxRetries).toBe(3);
    expect(config.githubHost).toBe("github.com");
    expect(config.callbackAllowedHosts).toEqual([]);
    expect(config.jobId).toBeTruthy(); // randomUUID fallback
  });

  it("falls back from an unknown transport to stdout", async () => {
    process.env.RECIPE_TRANSPORT = "carrier-pigeon";
    expect((await loadConfig()).transport).toBe("stdout");
  });

  it("honors a valid transport value", async () => {
    process.env.RECIPE_TRANSPORT = "nats";
    expect((await loadConfig()).transport).toBe("nats");
  });

  it("prefers GITHUB_TOKEN, then GH_TOKEN, then empty string", async () => {
    process.env.GITHUB_TOKEN = "ghp_primary";
    process.env.GH_TOKEN = "ghp_secondary";
    expect((await loadConfig()).githubToken).toBe("ghp_primary");

    delete process.env.GITHUB_TOKEN;
    expect((await loadConfig()).githubToken).toBe("ghp_secondary");

    delete process.env.GH_TOKEN;
    expect((await loadConfig()).githubToken).toBe("");
  });

  it("ignores non-positive / non-numeric numeric overrides and keeps the fallback", async () => {
    process.env.GITHUB_TOOL_TIMEOUT_MS = "not-a-number";
    expect((await loadConfig()).ghTimeoutMs).toBe(30_000);

    process.env.GITHUB_TOOL_TIMEOUT_MS = "-5";
    expect((await loadConfig()).ghTimeoutMs).toBe(30_000);

    process.env.GITHUB_TOOL_TIMEOUT_MS = "1234";
    expect((await loadConfig()).ghTimeoutMs).toBe(1234);
  });

  it("defaults the GitHub App fields to empty and the API base to github.com", async () => {
    const config = await loadConfig();
    expect(config.githubAppId).toBe("");
    expect(config.githubAppPrivateKey).toBe("");
    expect(config.githubAppInstallationId).toBe("");
    expect(config.githubApiUrl).toBe("https://api.github.com");
  });

  it("normalizes a PEM stored with literal backslash-n escapes into real newlines", async () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nMIIabc\\n-----END RSA PRIVATE KEY-----";
    expect((await loadConfig()).githubAppPrivateKey).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    );
  });

  it("leaves a PEM that already has real newlines untouched", async () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;
    expect((await loadConfig()).githubAppPrivateKey).toBe(pem);
  });

  it("parses a comma list into trimmed, lower-cased, non-empty hosts", async () => {
    process.env.RECIPE_CALLBACK_ALLOWED_HOSTS = " Orchestrator.Svc , , nats.svc ";
    expect((await loadConfig()).callbackAllowedHosts).toEqual(["orchestrator.svc", "nats.svc"]);
  });
});
