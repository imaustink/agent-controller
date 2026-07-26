import { randomUUID } from "node:crypto";

/**
 * Central configuration. Kept deliberately narrow: this container's only
 * job is to run one allowlisted `gh` CLI invocation, authenticated as
 * whatever `GITHUB_TOKEN` its ToolRun's secretEnv supplied, and report the
 * result -- no model/formatting knobs here (contrast recipe-scraper).
 *
 * The `RECIPE_*` names below are NOT a copy/paste mistake -- they are the
 * fixed messaging-contract env var names the Go core-controller's
 * `buildRunJob` (controllers/core-controller/internal/controller/run_job.go)
 * injects into every ToolRun-launched Job's container regardless of the
 * tool's own name (see that file's `RECIPE_TRANSPORT`/`RECIPE_CALLBACK_URL`/
 * `RECIPE_CALLBACK_SECRET`/`RECIPE_NATS_SUBJECT`/`RECIPE_NATS_URL`) --
 * every tool in this repo that is actually wired up as a production ToolRun
 * (recipe-scraper, recipe-publisher, this one) reads these same names so
 * the callback/NATS result-delivery plumbing works end-to-end.
 */
export interface AppConfig {
  /** Message-passing transport for events (see docs/messaging.md). */
  transport: "stdout" | "events" | "file" | "callback" | "nats";
  /** Correlation id for this tool call; generated if not provided. */
  jobId: string;
  /** File path for the `file` transport (NDJSON, append-only). */
  eventsPath: string;
  /**
   * HTTP callback endpoint for the `callback` transport. MUST be supplied by
   * the trusted parent orchestrator/controller, never derived from tool input.
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
  /**
   * The GitHub token `gh` authenticates with -- normally the CALLING user's
   * own delegated OAuth token, injected per-invocation via
   * `ToolRunSpec.secretEnv` by agent-orchestrator's identity-link gateway
   * client (ADR 0022/0027), never a shared bot credential baked into this
   * Tool's image/template. Falls back to `GH_TOKEN` for parity with `gh`'s
   * own env var precedence (both are set by this tool's own subprocess
   * wrapper regardless of which one the caller supplied -- see github.ts).
   */
  githubToken: string;
  /** Fixed GitHub API host `gh` is configured to talk to -- see github.ts. Not caller-controlled. */
  githubHost: string;
  /** Bound on how long a single `gh` invocation may run. */
  ghTimeoutMs: number;
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
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/github-tool-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
  githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "",
  githubHost: process.env.GH_HOST ?? "github.com",
  ghTimeoutMs: num(process.env.GITHUB_TOOL_TIMEOUT_MS, 30_000),
};
