import { randomUUID } from "node:crypto";

/**
 * Central configuration. The SearXNG target (base URL) is deliberately fixed
 * via env vars, never derived from tool args/caller/LLM input -- same
 * "trusted config, untrusted input" discipline as recipe-publisher's Mealie
 * base URL handling.
 */
export interface AppConfig {
  /** Base URL of the in-cluster SearXNG instance, e.g. http://agent-controller-searxng:8080 (no trailing slash). */
  searxngBaseUrl: string;
  /** Timeout for SearXNG API requests. */
  fetchTimeoutMs: number;
  /** Max number of results to include in the rendered output. */
  maxResults: number;
  /** Message-passing transport for events (see ../../docs/messaging.md and src/messaging/index.ts). */
  transport: "stdout" | "events" | "file" | "callback" | "nats";
  /** Correlation id for this tool call; generated if not provided. */
  jobId: string;
  /** File path for the `file` transport (NDJSON, append-only). */
  eventsPath: string;
  /**
   * HTTP callback endpoint for the `callback` transport. MUST be supplied by
   * the trusted parent orchestrator, never derived from tool input.
   */
  callbackUrl: string | undefined;
  /** Optional shared secret; enables HMAC-SHA256 signing of callback bodies. */
  callbackSecret: string | undefined;
  /** Allowlist of hosts the callback may target. */
  callbackAllowedHosts: string[];
  /** Delivery retry attempts for the callback transport. */
  callbackMaxRetries: number;
  /** NATS server URL for the `nats` transport, e.g. nats://nats.svc:4222 */
  natsUrl: string | undefined;
  /** NATS subject to publish tool events to for the `nats` transport. */
  natsSubject: string | undefined;
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
    case "nats":
      return raw;
    default:
      return "stdout";
  }
}

/** Strips a single trailing slash so URL-joining is consistent regardless of how the operator entered it. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// NOTE: the messaging-transport env vars below are named RECIPE_* even
// though this tool has nothing to do with recipes -- that's the actual wire
// protocol core-controller's Job builder hardcodes for every Tool
// (controllers/core-controller/internal/controller/run_job.go), a legacy
// name carried over from the first tools it supported. Renaming these to
// WEB_SEARCH_* (as an earlier version of this file did) silently breaks
// result delivery: the controller injects RECIPE_TRANSPORT=nats/callback
// unconditionally, so a tool reading a different var name never sees it and
// falls back to `stdout`, meaning its result never reaches the orchestrator.
export const config: AppConfig = {
  searxngBaseUrl: trimTrailingSlash(process.env.SEARXNG_BASE_URL ?? ""),
  fetchTimeoutMs: num(process.env.WEB_SEARCH_FETCH_TIMEOUT_MS, 15_000),
  maxResults: num(process.env.WEB_SEARCH_MAX_RESULTS, 10),
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/web-search-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
