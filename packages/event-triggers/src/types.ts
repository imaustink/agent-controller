// Shapes from docs/event-triggers.md §1-§2 and §5. The CR types mirror
// controllers/core-controller/api/v1alpha1/eventsource_types.go and
// eventtrigger_types.go (JSON field names).

import type { JsonValue } from "./values.js";

// ---------------------------------------------------------------------------
// §2 envelope
// ---------------------------------------------------------------------------

export type EnvelopeKind = "webhook" | "cron";

export interface EnvelopeSender {
  login?: string;
  isBot?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface Envelope {
  source: string;
  kind: EnvelopeKind;
  id: string;
  /** RFC 3339, UTC. */
  time: string;
  /** Lower-cased names; authorization, cookie and the verify header removed. */
  headers: Record<string, string>;
  body: JsonValue;
  /** `{login, isBot}` when the source's sender resolved, else `{}`. */
  sender: EnvelopeSender;
  /** `repositoryFrom` result, else "". */
  repository: string;
}

// ---------------------------------------------------------------------------
// §1 CRDs
// ---------------------------------------------------------------------------

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

export interface SecretKeySelector {
  name: string;
  key: string;
}

export type WebhookVerifyScheme = "hmacSha256" | "slackV0" | "bearer";

export interface WebhookVerify {
  scheme: WebhookVerifyScheme;
  header?: string;
  prefix?: string;
  secretRef: SecretKeySelector;
}

export interface WebhookSource {
  verify: WebhookVerify;
  deliveryIdHeader?: string;
}

export interface CronSource {
  schedule: string;
  timeZone?: string;
  suspend?: boolean;
  payload?: JsonValue;
}

export interface EventSender {
  provider: "github";
  loginFrom: string;
  isBotFrom?: string;
  repositoryFrom?: string;
  dropBots?: boolean;
}

export interface EventSourceSpec {
  webhook?: WebhookSource;
  cron?: CronSource;
  sender?: EventSender;
}

export interface EventSourceStatus {
  cronJobName?: string;
  conditions?: Condition[];
}

export interface EventSourceResource {
  apiVersion?: string;
  kind?: "EventSource";
  metadata: ObjectMeta;
  spec: EventSourceSpec;
  status?: EventSourceStatus;
}

export interface EventTriggerMatch {
  cel?: string;
}

export interface EventTriggerTargetSpec {
  orchestrator?: Record<string, unknown>;
  skillRef?: string;
  agentRef?: string;
  toolRef?: string;
  promptTemplate?: string;
  readOnly?: boolean;
}

export interface GitHubReplySpec {
  repository: string;
  issueNumber: string;
  ack?: string;
  sessionPage?: boolean;
  result?: boolean;
  removeLabel?: string;
}

export interface HttpReplySpec {
  url: string;
  secretRef?: SecretKeySelector;
}

export interface EventTriggerReplySpec {
  github?: GitHubReplySpec;
  http?: HttpReplySpec;
}

export interface EventTriggerSpec {
  sourceRef?: string;
  priority?: number;
  match?: EventTriggerMatch;
  params?: Record<string, string>;
  sessionKey?: string;
  target: EventTriggerTargetSpec;
  reply?: EventTriggerReplySpec;
}

export interface EventTriggerStatus {
  conditions?: Condition[];
}

export interface EventTriggerResource {
  apiVersion?: string;
  kind?: "EventTrigger";
  metadata: ObjectMeta;
  spec: EventTriggerSpec;
  status?: EventTriggerStatus;
}

// ---------------------------------------------------------------------------
// Resolved dispatch (§4-§5)
// ---------------------------------------------------------------------------

export type TriggerTargetKind = "orchestrator" | "skill" | "agent" | "tool";

export interface TriggerTarget {
  kind: TriggerTargetKind;
  /** Skill / Agent / Tool id; absent for "orchestrator". */
  ref?: string;
  readOnly: boolean;
  promptTemplate?: string;
}

/** `reply` with every template rendered; `issueNumber` parsed to a number. */
export interface RenderedReply {
  github?: {
    repository: string;
    issueNumber: number;
    ack?: string;
    sessionPage?: boolean;
    result?: boolean;
    removeLabel?: string;
  };
  http?: {
    url: string;
    secretRef?: SecretKeySelector;
  };
}
