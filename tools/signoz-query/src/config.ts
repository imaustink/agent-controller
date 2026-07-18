import { randomUUID } from "node:crypto";

export interface AppConfig {
  transport: "stdout" | "events" | "file" | "callback" | "nats";
  jobId: string;
  eventsPath: string;
  callbackUrl: string | undefined;
  callbackSecret: string | undefined;
  callbackAllowedHosts: string[];
  callbackMaxRetries: number;
  natsUrl: string | undefined;
  natsSubject: string | undefined;
  /** Fixed, operator-configured SigNoz Query Service base URL. Never derived
   * from caller input -- this tool has no SSRF surface because of that. */
  signozBaseUrl: string;
  /** Optional API key sent as the SIGNOZ-API-KEY header. */
  signozApiKey: string | undefined;
  /** Bound on the query time window, regardless of what the caller asked for. */
  maxLookbackMs: number;
  /** Timeout for the SigNoz HTTP request. */
  fetchTimeoutMs: number;
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
  transport: transport(process.env.SIGNOZ_TRANSPORT),
  jobId: process.env.SIGNOZ_JOB_ID ?? randomUUID(),
  eventsPath: process.env.SIGNOZ_EVENTS_PATH ?? "/tmp/signoz-query-events.ndjson",
  callbackUrl: process.env.SIGNOZ_CALLBACK_URL,
  callbackSecret: process.env.SIGNOZ_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.SIGNOZ_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.SIGNOZ_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.SIGNOZ_NATS_URL,
  natsSubject: process.env.SIGNOZ_NATS_SUBJECT,
  signozBaseUrl: process.env.SIGNOZ_BASE_URL ?? "",
  signozApiKey: process.env.SIGNOZ_API_KEY,
  maxLookbackMs: num(process.env.SIGNOZ_MAX_LOOKBACK_MS, 24 * 60 * 60 * 1000),
  fetchTimeoutMs: num(process.env.SIGNOZ_FETCH_TIMEOUT_MS, 15_000),
};
