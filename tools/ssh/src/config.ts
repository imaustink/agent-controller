import { randomUUID } from "node:crypto";
import { parseSshConfig, type SshConfigEntry } from "./sshconfig.js";
import type { Target } from "./target.js";

/**
 * Central configuration. Kept deliberately narrow: this container's only job
 * is to run one allowlisted read-only remote command over SSH against one
 * resolved host and report the result (see tools/kubectl-readonly's
 * config.ts for the sibling comment on scope).
 *
 * The `RECIPE_*` names below are NOT a copy/paste mistake -- they are the
 * fixed messaging-contract env var names the Go core-controller's
 * `buildRunJob` (controllers/core-controller/internal/controller/run_job.go)
 * injects into every ToolRun-launched Job's container regardless of the
 * tool's own name. Every tool in this repo that is actually wired up as a
 * production ToolRun with callback/NATS delivery (recipe-scraper,
 * recipe-publisher, github) reads these same names; this tool follows suit
 * rather than inventing an `SSH_*` prefix for them (contrast
 * tools/kubectl-readonly's `KUBECTL_*` names, which only work with the
 * `stdout` transport in production as a result).
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
  /**
   * Optional restriction on which resolved user@host:port targets may be
   * dialed at all -- from `SSH_ALLOWED_HOSTS`, a comma-separated
   * "user@host[:port]" list. `null` when unset, meaning NO restriction is
   * applied beyond what SSH_CONFIG's own Host list happens to resolve --
   * see target.ts's file header for why this and SSH_CONFIG are independent
   * features, and index.ts's startup check for why at least one of the two
   * must be configured.
   */
  allowedHosts: Target[] | null;
  /**
   * Optional ssh_config(5)-shaped content (see sshconfig.ts) for resolving
   * a caller-supplied alias (e.g. "kube0") to HostName/User/Port, the same
   * way the operator's own ~/.ssh/config already does. Independent of
   * allowedHosts above.
   */
  sshConfig: string;
  sshConfigEntries: SshConfigEntry[];
  /** Fallback user when a target supplies none and no SSH_CONFIG Host block
   * sets one either. Optional -- resolution fails closed without a user. */
  defaultUser: string | undefined;
  /** PEM-encoded private key content (secretEnv-injected, never baked into the image). */
  privateKey: string;
  /** `known_hosts`-format content pinning the allowed hosts' host keys. Not
   * secret, but required: StrictHostKeyChecking stays on unconditionally. */
  knownHosts: string;
  /** Bound on how long a single ssh invocation may run. */
  sshTimeoutMs: number;
  /** Bound on the initial TCP+auth handshake, passed to ssh as ConnectTimeout. */
  connectTimeoutSec: number;
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

/** Parses "user@host[:port]" allowlist entries; malformed entries are a
 * startup-time config error, not a runtime one -- fail loud, not open.
 * Returns `null` when SSH_ALLOWED_HOSTS is unset entirely (as opposed to
 * set-but-empty, which is still a config error), meaning the allowlist
 * feature is simply off -- see the AppConfig.allowedHosts doc comment. */
function parseAllowedHosts(raw: string | undefined): Target[] | null {
  if (raw === undefined) return null;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("SSH_ALLOWED_HOSTS is set but empty -- unset it entirely to disable the allowlist.");
  }
  return entries.map((entry) => {
    const atIdx = entry.indexOf("@");
    if (atIdx === -1) {
      throw new Error(`SSH_ALLOWED_HOSTS entry "${entry}" is missing a "user@" prefix.`);
    }
    const user = entry.slice(0, atIdx).toLowerCase();
    const hostPort = entry.slice(atIdx + 1);
    const colonIdx = hostPort.lastIndexOf(":");
    const host = (colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx)).toLowerCase();
    const port = colonIdx === -1 ? 22 : Number(hostPort.slice(colonIdx + 1));
    if (!user || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`SSH_ALLOWED_HOSTS entry "${entry}" is not a valid "user@host[:port]".`);
    }
    return { user, host, port };
  });
}

const sshConfigRaw = process.env.SSH_CONFIG ?? "";

export const config: AppConfig = {
  transport: transport(process.env.RECIPE_TRANSPORT),
  jobId: process.env.RECIPE_JOB_ID ?? randomUUID(),
  eventsPath: process.env.RECIPE_EVENTS_PATH ?? "/tmp/ssh-tool-events.ndjson",
  callbackUrl: process.env.RECIPE_CALLBACK_URL,
  callbackSecret: process.env.RECIPE_CALLBACK_SECRET,
  callbackAllowedHosts: list(process.env.RECIPE_CALLBACK_ALLOWED_HOSTS),
  callbackMaxRetries: num(process.env.RECIPE_CALLBACK_MAX_RETRIES, 3),
  natsUrl: process.env.RECIPE_NATS_URL,
  natsSubject: process.env.RECIPE_NATS_SUBJECT,
  allowedHosts: parseAllowedHosts(process.env.SSH_ALLOWED_HOSTS),
  sshConfig: sshConfigRaw,
  sshConfigEntries: parseSshConfig(sshConfigRaw),
  defaultUser: process.env.SSH_DEFAULT_USER,
  privateKey: process.env.SSH_PRIVATE_KEY ?? "",
  knownHosts: process.env.SSH_KNOWN_HOSTS ?? "",
  sshTimeoutMs: num(process.env.SSH_TIMEOUT_MS, 15_000),
  connectTimeoutSec: num(process.env.SSH_CONNECT_TIMEOUT_SEC, 10),
};
