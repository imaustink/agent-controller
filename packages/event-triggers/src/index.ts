// @controller-agent/event-triggers — the EventSource/EventTrigger contract
// (ADR 0048, docs/event-triggers.md): envelope, CEL environment, matching,
// params and templates. Pure logic; no Kubernetes client.

export type {
  Condition,
  CronSource,
  Envelope,
  EnvelopeKind,
  EnvelopeSender,
  EventSender,
  EventSourceResource,
  EventSourceSpec,
  EventSourceStatus,
  EventTriggerMatch,
  EventTriggerReplySpec,
  EventTriggerResource,
  EventTriggerSpec,
  EventTriggerStatus,
  EventTriggerTargetSpec,
  GitHubReplySpec,
  HttpReplySpec,
  ObjectMeta,
  RenderedReply,
  SecretKeySelector,
  TriggerTarget,
  TriggerTargetKind,
  WebhookSource,
  WebhookVerify,
  WebhookVerifyScheme,
} from "./types.js";

export {
  canonicalJson,
  celTypeOf,
  fromTypedParam,
  normalizeJson,
  paramToString,
  toJsonValue,
  toTypedParam,
  UnsupportedValueError,
} from "./values.js";
export type { CelTypeName, CelValue, JsonValue, TypedParam } from "./values.js";

export { compileExpression, envelopeActivation, evaluate } from "./cel.js";
export type { Activation, CompileResult, CompiledExpression, EvaluateResult } from "./cel.js";

export { PLACEHOLDER_PATTERN, renderTemplate } from "./template.js";

export { compileTrigger, selectTrigger } from "./trigger.js";
export type { CompiledParam, CompiledTrigger, SelectOptions, SelectResult } from "./trigger.js";

export {
  ALWAYS_DROPPED_HEADERS,
  buildCronEnvelope,
  buildWebhookEnvelope,
  formatEventTime,
  normalizeHeaders,
  parseBody,
} from "./envelope.js";
export type { CronEnvelopeInput, RawHeaders, WebhookEnvelopeInput } from "./envelope.js";
