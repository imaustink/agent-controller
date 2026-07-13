import { randomUUID } from "node:crypto";

/**
 * Central configuration for the copilot-swe tool.
 *
 * There are TWO distinct GitHub credentials here, on purpose:
 *
 *   1. COPILOT_GITHUB_TOKEN — a fine-grained (v2) PAT with the "Copilot
 *      Requests" permission, belonging to an account with a Copilot
 *      subscription. This authenticates the Copilot *model* only. (Classic
 *      `ghp_` tokens and GitHub App installation tokens are NOT accepted by
 *      the Copilot CLI for model auth.)
 *
 *   2. A GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) — used to mint a
 *      short-lived *installation* token at run time, which authenticates all
 *      git/`gh` operations (clone, push, PR, repo create). The App install is
 *      what bounds which repos this tool can touch.
 *
 * Everything security-relevant (both tokens, target hosts) is fixed via env,
 * never derived from the caller's instruction — same "trusted config,
 * untrusted input" discipline as the other tools in this repo.
 */
export interface AppConfig {
  /** GitHub App id (numeric, as a string). Not secret. */
  githubAppId: string;
  /** GitHub App installation id, if known ahead of time. Otherwise discovered at run time. */
  githubAppInstallationId: string | undefined;
  /** GitHub App private key (PEM). THE app secret; inject via secretEnv/secretKeyRef. May be base64-encoded. */
  githubAppPrivateKey: string;
  /** Fine-grained PAT with "Copilot Requests" for the Copilot model. THE copilot secret; inject via secretEnv. */
  copilotGithubToken: string;
  /** GitHub REST API base (override for GitHub Enterprise Server). */
  githubApiUrl: string;
  /** Copilot model id to pin (COPILOT_MODEL); empty => let Copilot choose. */
  copilotModel: string;
  /** Writable working directory the coding agent operates in (under an emptyDir/tmpfs). */
  workdir: string;
  /** Writable HOME for git/gh/copilot state (COPILOT_HOME lives beneath this). */
  homeDir: string;
  /** Timeout for the tool's own GitHub REST calls (token minting, PR discovery). */
  fetchTimeoutMs: number;

  /** Message-passing transport for events (see ../../docs/messaging.md and src/messaging/index.ts). */
  transport: "stdout" | "events" | "file" | "callback";
  /** Correlation id for this tool call; generated if not provided. */
  jobId: string;
  /** File path for the `file` transport (NDJSON, append-only). */
  eventsPath: string;
  /** HTTP callback endpoint for the `callback` transport. Supplied by the trusted parent, never from input. */
  callbackUrl: string | undefined;
  /** Optional shared secret; enables HMAC-SHA256 signing of callback bodies. */
  callbackSecret: string | undefined;
  /** Allowlist of hosts the callback may target. */
  callbackAllowedHosts: string[];
  /** Delivery retry attempts for the callback transport. */
  callbackMaxRetries: number;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function transport(raw: string | undefined): AppConfig["transport"] {
  switch (raw) {
    case "events":
    case "file":
    case "callback":
      return raw;
    default:
      return "stdout";
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * The private key may be provided as raw PEM (with real newlines) or, for
 * environments where multi-line env vars are awkward, base64-encoded. Detect
 * PEM by its header and base64-decode otherwise.
 */
function decodePrivateKey(raw: string): string {
  const value = raw.trim();
  if (value.includes("-----BEGIN")) return value;
  if (value === "") return "";
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? decoded : value;
  } catch {
    return value;
  }
}

export const config: AppConfig = {
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID || undefined,
  githubAppPrivateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY ?? ""),
  copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN ?? "",
  githubApiUrl: trimTrailingSlash(process.env.GITHUB_API_URL ?? "https://api.github.com"),
  copilotModel: process.env.COPILOT_MODEL ?? "",
  workdir: process.env.COPILOT_SWE_WORKDIR ?? "/tmp/work",
  homeDir: process.env.COPILOT_SWE_HOME ?? "/tmp/home",
  fetchTimeoutMs: num(process.env.COPILOT_SWE_FETCH_TIMEOUT_MS, 30_000),

  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/copilot-swe-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
};
