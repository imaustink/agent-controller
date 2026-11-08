import { randomUUID } from "node:crypto";

/**
 * Central configuration. Kept deliberately narrow: this container's only job
 * is to run one allowlisted read-only kubectl invocation and report the
 * result, so there are no model/formatting knobs here (contrast recipe-scraper).
 */
export interface AppConfig {
  /** Message-passing transport for events (see docs/messaging.md). */
  transport: "stdout" | "events" | "file" | "callback" | "nats";
  /** Correlation id for this tool call; generated if not provided. */
  jobId: string;
  /** File path for the `file` transport (NDJSON, append-only). */
  eventsPath: string;
  /** HTTP callback endpoint for the `callback` transport. */
  callbackUrl: string | undefined;
  /** Optional shared secret; enables HMAC-SHA256 signing of callback bodies. */
  callbackSecret: string | undefined;
  /** Allowlist of hosts the callback may target. */
  callbackAllowedHosts: string[];
  /** Delivery retry attempts for the callback transport. */
  callbackMaxRetries: number;
  /** NATS server URL for the `nats` transport. */
  natsUrl: string | undefined;
  /** NATS subject to publish tool events to for the `nats` transport. */
  natsSubject: string | undefined;
  /** Path to the projected ServiceAccount token, for in-cluster kubectl auth. */
  serviceAccountTokenPath: string;
  /** Path to the projected ServiceAccount CA cert, for in-cluster kubectl auth. */
  serviceAccountCaPath: string;
  /** Bound on how long a single kubectl invocation may run. */
  kubectlTimeoutMs: number;
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
  transport: transport(process.env.KUBECTL_TRANSPORT),
  jobId: process.env.KUBECTL_JOB_ID ?? randomUUID(),
  eventsPath: process.env.KUBECTL_EVENTS_PATH ?? "/tmp/kubectl-readonly-events.ndjson",
  callbackUrl: process.env.KUBECTL_CALLBACK_URL,
  callbackSecret: process.env.KUBECTL_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.KUBECTL_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.KUBECTL_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.KUBECTL_NATS_URL,
  natsSubject: process.env.KUBECTL_NATS_SUBJECT,
  serviceAccountTokenPath:
    process.env.KUBECTL_SA_TOKEN_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/token",
  serviceAccountCaPath:
    process.env.KUBECTL_SA_CA_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  kubectlTimeoutMs: num(process.env.KUBECTL_TIMEOUT_MS, 15_000),
};
