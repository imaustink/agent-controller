import { z } from "zod";

/**
 * Bidirectional control protocol for **agents** (sub-agent Jobs launched from
 * an `AgentRun`), distinct from the one-way {@link Event} stream that ordinary
 * tools emit. Where a tool runs once and reports `accepted -> progress* ->
 * succeeded|failed` in a single direction, an agent holds a live, two-way
 * conversation with the orchestrator for the life of its Job:
 *
 * - **up** (agent -> orchestrator): `ready`, `progress`, `warning`,
 *   `reply` (the concluding assistant message for the current turn), `failed`.
 * - **down** (orchestrator -> agent): `prompt` (a user turn — the initial
 *   goal or any follow-up), `cancel`, `signal`.
 *
 * The protocol is transport-agnostic (this package deliberately has no NATS
 * dependency): messages are plain JSON validated by the schemas below. The
 * concrete carrier is NATS — one subject per direction, keyed by the
 * `AgentRun` id (see {@link agentSubjects}).
 *
 * Human-in-the-loop is expressed WITHOUT a dedicated ask/answer message pair:
 * an agent asks the user a question simply by emitting a `reply` with
 * `final: false` (the question text becomes the turn's assistant message); the
 * user's answer arrives as the next `prompt`. The `@controller-agent/agent-runtime`
 * SDK layers an ergonomic `askUser()` helper over exactly this. Modeling a
 * question as "a non-final reply awaiting the next prompt" (rather than a
 * synchronous request/reply) is deliberate: a human may take arbitrarily long
 * and answer across chat turns, so no reply timeout can apply.
 */

/** Fields present on every agent protocol message, both directions. */
const AgentMessageBaseSchema = z.object({
  /** Correlation id = the AgentRun's name; shared by every message of one agent run. */
  agent_run_id: z.string(),
  /** Monotonic per-direction sequence number; ordering + dedupe. */
  seq: z.number().int().nonnegative(),
  /** ISO 8601 emission timestamp. */
  ts: z.string(),
});
type AgentMessageBase = z.infer<typeof AgentMessageBaseSchema>;

/** agent -> orchestrator. */
export const AgentUpMessageSchema = z.discriminatedUnion("type", [
  // Agent has booted, subscribed to its down subject, and is ready to work.
  AgentMessageBaseSchema.extend({ type: z.literal("ready") }),
  // Incremental progress narration surfaced to the user.
  AgentMessageBaseSchema.extend({
    type: z.literal("progress"),
    stage: z.string().optional(),
    message: z.string(),
    pct: z.number().min(0).max(100).optional(),
  }),
  AgentMessageBaseSchema.extend({ type: z.literal("warning"), message: z.string() }),
  // The concluding assistant message for the current turn. `final: false`
  // means the agent is awaiting a further `prompt` (including the case where
  // `message` is a question to the user — HITL); `final: true` means the agent
  // considers the whole task complete and is exiting after this.
  AgentMessageBaseSchema.extend({
    type: z.literal("reply"),
    message: z.string(),
    final: z.boolean(),
    // Optional structured result for non-chat consumers (AgentRun status, etc.).
    result: z.unknown().optional(),
  }),
  // Terminal failure.
  AgentMessageBaseSchema.extend({
    type: z.literal("failed"),
    code: z.string(),
    message: z.string(),
  }),
]);

/** orchestrator -> agent. */
export const AgentDownMessageSchema = z.discriminatedUnion("type", [
  // A user turn for the agent to act on: the initial goal (first `prompt`) or
  // any follow-up turn in the same conversation (HITL continuation).
  AgentMessageBaseSchema.extend({
    type: z.literal("prompt"),
    message: z.string(),
  }),
  // Ask the agent to stop and exit (user abandoned the conversation, timeout, etc.).
  AgentMessageBaseSchema.extend({
    type: z.literal("cancel"),
    reason: z.string().optional(),
  }),
  // Generic out-of-band control signal (extension point).
  AgentMessageBaseSchema.extend({
    type: z.literal("signal"),
    name: z.string(),
    data: z.unknown().optional(),
  }),
]);

/** agent -> orchestrator message, parameterized by the agent's `final.result` shape. */
export type AgentUpMessage<TResult = unknown> =
  | (AgentMessageBase & { type: "ready" })
  | (AgentMessageBase & { type: "progress"; stage?: string; message: string; pct?: number })
  | (AgentMessageBase & { type: "warning"; message: string })
  | (AgentMessageBase & { type: "reply"; message: string; final: boolean; result?: TResult })
  | (AgentMessageBase & { type: "failed"; code: string; message: string });

/** orchestrator -> agent message. */
export type AgentDownMessage =
  | (AgentMessageBase & { type: "prompt"; message: string })
  | (AgentMessageBase & { type: "cancel"; reason?: string })
  | (AgentMessageBase & { type: "signal"; name: string; data?: unknown });

/** NATS subject names for one agent run's two directions. */
export interface AgentSubjects {
  /** agent publishes, orchestrator subscribes. */
  up: string;
  /** orchestrator publishes, agent subscribes. */
  down: string;
}

/**
 * Deterministic subject names for an agent run. Keyed by the AgentRun id so a
 * follow-up user turn (correlated via the conversation/session id) can be
 * published to the exact running agent regardless of which orchestrator
 * replica launched it — the whole reason for a queue over a direct socket.
 *
 * `prefix` defaults to `agent`; override only if the NATS account namespaces
 * subjects differently.
 */
export function agentSubjects(agentRunId: string, prefix = "agent"): AgentSubjects {
  return {
    up: `${prefix}.${agentRunId}.up`,
    down: `${prefix}.${agentRunId}.down`,
  };
}
