import { randomUUID } from "node:crypto";

/**
 * Central configuration. All limits are deliberately conservative because this
 * container ingests attacker-controlled content and forwards it to paid APIs.
 */
export interface AppConfig {
  formatModel: string;
  visionModel: string;
  transcribeModel: string;
  /** Max characters of extracted text forwarded to the formatting LLM. */
  maxTextChars: number;
  /** Max bytes accepted when downloading an image. */
  maxImageBytes: number;
  /** Max number of slides OCR'd from a TikTok photo (slideshow) post, to bound vision cost. */
  maxTikTokImages: number;
  /** Max bytes accepted when downloading audio for transcription. */
  maxAudioBytes: number;
  /** Playwright navigation timeout. */
  navTimeoutMs: number;
  /** Timeout for external subprocesses (yt-dlp / ffmpeg). */
  subprocessTimeoutMs: number;
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
   * the trusted parent orchestrator, never derived from scraped content.
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

export const config: AppConfig = {
  formatModel: process.env.RECIPE_FORMAT_MODEL ?? "gpt-4o-2024-08-06",
  visionModel: process.env.RECIPE_VISION_MODEL ?? "gpt-4o-2024-08-06",
  transcribeModel: process.env.RECIPE_TRANSCRIBE_MODEL ?? "whisper-1",
  maxTextChars: num(process.env.RECIPE_MAX_TEXT_CHARS, 100_000),
  maxImageBytes: num(process.env.RECIPE_MAX_IMAGE_BYTES, 15 * 1024 * 1024),
  maxTikTokImages: num(process.env.RECIPE_MAX_TIKTOK_IMAGES, 12),
  maxAudioBytes: num(process.env.RECIPE_MAX_AUDIO_BYTES, 25 * 1024 * 1024),
  navTimeoutMs: num(process.env.RECIPE_NAV_TIMEOUT_MS, 30_000),
  subprocessTimeoutMs: num(process.env.RECIPE_SUBPROCESS_TIMEOUT_MS, 180_000),
  fetchTimeoutMs: num(process.env.RECIPE_FETCH_TIMEOUT_MS, 30_000),
  maxRedirects: num(process.env.RECIPE_MAX_REDIRECTS, 5),
  userAgent:
    process.env.RECIPE_USER_AGENT ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/recipe-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
