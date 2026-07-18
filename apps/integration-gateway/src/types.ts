/**
 * Phase-1 inbound invocation envelope for the integrations gateway.
 *
 * See ../../docs/integrations-gateway.md: only the `faas` channel is wired in
 * this phase, but the discriminator stays extensible for later adapters.
 */
export type InboundChannel = "faas" | (string & {});

/** Direct catalog target carried by a phase-1 FAAS invocation. */
export interface FaasTarget {
  kind: "tool" | "agent";
  id: string;
  args?: string[];
}

/**
 * Normalized inbound request shape adapters map into before launch logic runs.
 * In phase 1 the HTTP FAAS surface builds this directly.
 */
export interface InboundEvent {
  channel: InboundChannel;
  externalThreadId?: string;
  callerIdentity: unknown;
  text: string;
  target?: FaasTarget;
  replyRef?: unknown;
}
