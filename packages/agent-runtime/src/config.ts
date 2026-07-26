/**
 * Runtime configuration for a sub-agent process, read from the environment the
 * `AgentRun` controller injects (see the core-controller's agentrun job build).
 */
export interface AgentRuntimeConfig {
  /** NATS server URL (AGENT_NATS_URL). */
  natsUrl: string;
  /** This run's id = the AgentRun name (AGENT_RUN_ID); keys the up/down subjects. */
  runId: string;
  /** Subject prefix for agentSubjects (AGENT_NATS_SUBJECT_PREFIX, default "agent"). */
  subjectPrefix: string;
  /** The initial goal for this run (AGENT_GOAL, or argv[2] as a fallback). */
  goal: string;
  /**
   * How long to keep re-offering a concluding message that has not been acked
   * (AGENT_REPLY_ACK_TIMEOUT_MS), and how often (AGENT_REPLY_ACK_RETRY_MS) —
   * see `runtime.ts`'s `publishHeld`.
   *
   * Operationally relevant because holding is what keeps the answer collectable
   * across an orchestrator rollout, and it does so by keeping the Job's pod
   * alive that much longer when nobody collects. `0` disables holding entirely,
   * restoring the pre-`reply_ack` publish-and-exit behaviour — the escape hatch
   * if an orchestrator that never acks is ever deployed against a newer agent
   * image.
   */
  replyAckTimeoutMs?: number;
  replyAckRetryMs?: number;
}

export class AgentConfigError extends Error {}

/**
 * Loads config from env (+ argv fallback for the goal). Throws
 * {@link AgentConfigError} if a required value is missing so the pod fails
 * fast with a clear message rather than connecting to a bogus server or
 * running with an empty goal.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): AgentRuntimeConfig {
  const natsUrl = env.AGENT_NATS_URL;
  const runId = env.AGENT_RUN_ID;
  const goal = env.AGENT_GOAL ?? argv[2];

  const missing: string[] = [];
  if (!natsUrl) missing.push("AGENT_NATS_URL");
  if (!runId) missing.push("AGENT_RUN_ID");
  if (!goal) missing.push("AGENT_GOAL (or argv[2])");
  if (missing.length > 0) {
    throw new AgentConfigError(`missing required agent runtime config: ${missing.join(", ")}`);
  }

  return {
    natsUrl: natsUrl!,
    runId: runId!,
    subjectPrefix: env.AGENT_NATS_SUBJECT_PREFIX ?? "agent",
    goal: goal!,
    ...numeric("replyAckTimeoutMs", env.AGENT_REPLY_ACK_TIMEOUT_MS),
    ...numeric("replyAckRetryMs", env.AGENT_REPLY_ACK_RETRY_MS),
  };
}

/**
 * Parses an optional numeric env override, omitting the key entirely when unset
 * so the runtime's own default applies. A non-numeric value is a
 * misconfiguration worth failing on rather than silently ignoring: a typo'd
 * timeout that reads as "use the default" is the kind of thing that is only
 * discovered during the incident it was meant to prevent.
 */
function numeric(key: string, raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw === "") return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentConfigError(`invalid ${key} (${raw}): expected a non-negative number of milliseconds`);
  }
  return { [key]: value };
}
