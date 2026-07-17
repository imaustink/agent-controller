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
  };
}
