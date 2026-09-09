import { randomUUID } from "node:crypto";

/**
 * Central configuration. The Glyph API target (base URL) is deliberately
 * fixed via env vars, never derived from tool args/caller/LLM input — the
 * same "trusted config, untrusted input" discipline recipe-publisher applies
 * to its Mealie base URL and the github tool applies to `GH_HOST`.
 *
 * The `RECIPE_*` names below are NOT a copy/paste mistake — they are the
 * fixed messaging-contract env var names the Go core-controller's
 * `buildRunJob` (controllers/core-controller/internal/controller/run_job.go)
 * injects into every ToolRun-launched Job's container regardless of the
 * tool's own name. Every tool in this repo wired up as a production ToolRun
 * reads these same names so the callback/NATS result-delivery plumbing works
 * end-to-end (see tools/github/src/config.ts's note on this).
 */
export interface AppConfig {
  /** Base URL of the Glyph API, e.g. https://glyph.example.com (no trailing slash). The `/api/v1` prefix is added by the client. */
  glyphBaseUrl: string;
  /**
   * The Glyph access token requests authenticate with — normally the CALLING
   * user's own OAuth-delegated bearer token (Glyph's per-user delegation,
   * `page:*`/`task:*` scopes), injected per-invocation via
   * `ToolRunSpec.secretEnv` by agent-orchestrator's identity-link gateway
   * client when this Tool declares `identityProviders: [glyph]`, never a
   * shared credential baked into this Tool's image/template. Falls back to a
   * static operator-provisioned token for the shared-credential case (chart
   * default), exactly like the github tool's `GITHUB_TOKEN`.
   */
  glyphToken: string;
  /** Timeout for a single Glyph API request. */
  fetchTimeoutMs: number;
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

export const config: AppConfig = {
  glyphBaseUrl: trimTrailingSlash(process.env.GLYPH_BASE_URL ?? ""),
  glyphToken: process.env.GLYPH_TOKEN ?? "",
  fetchTimeoutMs: num(process.env.GLYPH_FETCH_TIMEOUT_MS, 30_000),
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/glyph-tool-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
