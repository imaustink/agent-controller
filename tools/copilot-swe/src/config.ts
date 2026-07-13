import { randomUUID } from "node:crypto";

/**
 * Central configuration for the copilot-swe tool.
 *
 * A SINGLE fine-grained (v2) GitHub PAT authenticates everything:
 *   - the Copilot *model* (the token needs the "Copilot Requests" account
 *     permission, from an account with a Copilot subscription), and
 *   - all git/`gh` operations (the token needs Contents + Pull requests write,
 *     plus Administration write if it should be able to create repos).
 *
 * The token is fixed via env, never derived from the caller's instruction —
 * same "trusted config, untrusted input" discipline as the other tools.
 */
export interface AppConfig {
  /**
   * The fine-grained PAT used for BOTH the Copilot model and git/gh. THE
   * secret; inject via secretEnv/secretKeyRef.
   */
  githubToken: string;
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

export const config: AppConfig = {
  githubToken: process.env.GITHUB_TOKEN ?? "",
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
