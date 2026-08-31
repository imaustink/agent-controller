import { randomUUID } from "node:crypto";

/**
 * Central configuration. Limits are deliberately conservative because this
 * container forwards an untrusted prompt (and optionally a caller-supplied
 * image URL) to paid APIs and uploads the result to an object store (same
 * discipline as tools/recipe-scraper/src/config.ts).
 */
export interface AppConfig {
  /** OpenAI image model. gpt-image-1 supports both generation and editing. */
  imageModel: string;
  /** Default image size (e.g. "1024x1024", "1024x1536", "auto"). */
  defaultSize: string;
  /** Default rendering quality passed to the model ("low"|"medium"|"high"|"auto"). */
  defaultQuality: string;
  /** Max bytes accepted when downloading a source image for the edit branch. */
  maxImageBytes: number;
  /** Timeout for guarded HTTP fetches (source-image download). */
  fetchTimeoutMs: number;
  /** Max redirects followed by guarded fetches. */
  maxRedirects: number;
  userAgent: string;

  // --- S3-compatible object store (BYO bucket; presigned GET URLs) ---
  /** Endpoint URL of the S3-compatible store, e.g. https://s3.example.com. */
  s3Endpoint: string | undefined;
  /** Region (many S3-compatible stores accept any value, e.g. "us-east-1"). */
  s3Region: string;
  /** Target bucket the generated/edited image is written to. */
  s3Bucket: string | undefined;
  /** Key prefix under the bucket (e.g. "images"). */
  s3Prefix: string;
  /** Lifetime of the returned presigned GET URL, in seconds. */
  s3PresignTtlSeconds: number;
  /**
   * Path-style addressing (bucket in the path, not the host). Required by most
   * self-hosted S3-compatible stores (MinIO, Ceph RGW); false for AWS S3.
   */
  s3ForcePathStyle: boolean;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;

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

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
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

// NOTE: the messaging-transport env vars below are named RECIPE_* even though
// this tool has nothing to do with recipes -- that's the actual wire protocol
// core-controller's Job builder hardcodes for every Tool
// (controllers/core-controller/internal/controller/run_job.go), a legacy name
// carried over from the first tools it supported. Same note as
// tools/web-fetch/src/config.ts.
export const config: AppConfig = {
  imageModel: process.env.IMAGE_MODEL ?? "gpt-image-1",
  defaultSize: process.env.IMAGE_SIZE ?? "1024x1024",
  defaultQuality: process.env.IMAGE_QUALITY ?? "auto",
  maxImageBytes: num(process.env.IMAGE_MAX_BYTES, 15 * 1024 * 1024),
  fetchTimeoutMs: num(process.env.IMAGE_FETCH_TIMEOUT_MS, 30_000),
  maxRedirects: num(process.env.IMAGE_MAX_REDIRECTS, 5),
  userAgent: process.env.IMAGE_USER_AGENT ?? "image-gen/0.1 (+controller-agent)",

  s3Endpoint: process.env.IMAGE_S3_ENDPOINT,
  s3Region: process.env.IMAGE_S3_REGION ?? "us-east-1",
  s3Bucket: process.env.IMAGE_S3_BUCKET,
  s3Prefix: (process.env.IMAGE_S3_PREFIX ?? "images").replace(/^\/+|\/+$/g, ""),
  s3PresignTtlSeconds: num(process.env.IMAGE_S3_PRESIGN_TTL_SECONDS, 7 * 24 * 60 * 60),
  s3ForcePathStyle: bool(process.env.IMAGE_S3_FORCE_PATH_STYLE, true),
  s3AccessKeyId: process.env.IMAGE_S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.IMAGE_S3_SECRET_ACCESS_KEY,

  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/image-gen-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
};
