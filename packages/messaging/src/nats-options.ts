import type { ConnectionOptions } from "nats";

/**
 * Reconnect policy for long-lived NATS connections on the agent path — the
 * orchestrator's agent channel and job receiver, and the agent runtime's own
 * channel.
 *
 * nats.js defaults to `maxReconnectAttempts: 10` at `reconnectTimeWait: 2000`,
 * so a NATS outage of barely 20 seconds closes the connection PERMANENTLY.
 * Nothing in this codebase watched for that or re-established, which meant:
 * on the orchestrator side every subscription under it closed and every
 * in-flight `awaitReply` ended for the rest of the process's life; on the
 * agent side the run could no longer publish its `reply` at all, so a run that
 * finished its work successfully was never heard from. Agent runs last hours,
 * so both sides must retry indefinitely instead.
 *
 * Jitter keeps multiple replicas from reconnecting in lockstep.
 *
 * Deliberately NOT applied to `NatsSink` (the container-tool result path):
 * those Jobs are short-lived and bounded by `activeDeadlineSeconds`, and an
 * unbounded reconnect there would just make `close()`'s drain hang until the
 * Job is reaped.
 */
export const NATS_RECONNECT_OPTIONS: Pick<
  ConnectionOptions,
  "maxReconnectAttempts" | "reconnectTimeWait" | "reconnectJitter"
> = {
  maxReconnectAttempts: -1,
  reconnectTimeWait: 2_000,
  reconnectJitter: 1_000,
};
