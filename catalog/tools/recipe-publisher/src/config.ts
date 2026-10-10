import { randomUUID } from "node:crypto";

/**
 * Central configuration. The Mealie publish target (base URL) is
 * deliberately fixed via env vars, never derived from tool args/caller/LLM
 * input — same "trusted config, untrusted input" discipline as
 * recipe-scraper's callback URL handling.
 */
export interface AppConfig {
  /** Base URL of the Mealie instance, e.g. https://recipes.kurpuis.com (no trailing slash). */
  mealieBaseUrl: string;
  /** Mealie long-lived API token (Settings -> API Tokens in the Mealie UI). THE secret; inject via secretEnv/secretKeyRef. */
  mealieApiToken: string;
  /** Which of Mealie's registered ingredient parsers to use when structuring ingredient quantity/unit/food (see src/mealie/client.ts). */
  mealieIngredientParser: "nlp" | "brute" | "openai";
  /** Timeout for Mealie API requests. */
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

function ingredientParser(raw: string | undefined): AppConfig["mealieIngredientParser"] {
  switch (raw) {
    case "brute":
    case "openai":
      return raw;
    default:
      return "nlp";
  }
}

export const config: AppConfig = {
  mealieBaseUrl: trimTrailingSlash(process.env.MEALIE_BASE_URL ?? ""),
  mealieApiToken: process.env.MEALIE_API_TOKEN ?? "",
  mealieIngredientParser: ingredientParser(process.env.MEALIE_INGREDIENT_PARSER),
  fetchTimeoutMs: num(process.env.RECIPE_PUBLISH_FETCH_TIMEOUT_MS, 30_000),
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/recipe-publisher-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
