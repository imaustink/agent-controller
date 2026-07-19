import { randomUUID } from "node:crypto";

/**
 * Central configuration. All limits are deliberately conservative because this
 * container fetches attacker-controlled page content (same discipline as
 * tools/recipe-scraper/src/config.ts).
 */
export interface AppConfig {
  /** Max bytes accepted when downloading a page. */
  maxBytes: number;
  /** Max characters of extracted text included in the rendered output. */
  maxChars: number;
  /** Timeout for guarded HTTP fetches. */
  fetchTimeoutMs: number;
  /** Max redirects followed by guarded fetches. */
  maxRedirects: number;
  userAgent: string;
  /** Message-passing transport for events (see ../../docs/messaging.md and src/messaging/index.ts). */
  transport: "stdout" | "events" | "file" | "callback" | "nats";
  /** Correlation id for this tool call; generated if not provided. */
  jobId: string;
  /** File path for the `file` transport (NDJSON, append-only). */
  eventsPath: string;
  /**
   * HTTP callback endpoint for the `callback` transport. MUST be supplied by
   * the trusted parent orchestrator, never derived from fetched content.
   */
  callbackUrl: string | undefined;
  /** Optional shared secret; enables HMAC-SHA256 signing of callback bodies. */
  callbackSecret: string | undefined;
  /**
   * Allowlist of hosts the callback may target. Deliberately distinct from the
   * SSRF url-guard: a callback legitimately targets private/cluster addresses.
   */
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

// NOTE: the messaging-transport env vars below are named RECIPE_* even
// though this tool has nothing to do with recipes -- that's the actual wire
// protocol core-controller's Job builder hardcodes for every Tool
// (controllers/core-controller/internal/controller/run_job.go), a legacy
// name carried over from the first tools it supported. See
// tools/web-search/src/config.ts for the same note.
export const config: AppConfig = {
  maxBytes: num(process.env.WEB_FETCH_MAX_BYTES, 10 * 1024 * 1024),
  maxChars: num(process.env.WEB_FETCH_MAX_CHARS, 20_000),
  fetchTimeoutMs: num(process.env.WEB_FETCH_TIMEOUT_MS, 15_000),
  maxRedirects: num(process.env.WEB_FETCH_MAX_REDIRECTS, 5),
  userAgent:
    process.env.WEB_FETCH_USER_AGENT ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/web-fetch-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
