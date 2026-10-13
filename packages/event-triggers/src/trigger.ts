// EventTrigger compilation and selection (docs/event-triggers.md §1, §4, §5).

import { compileExpression, evaluate, prepareActivation, type CompiledExpression } from "./cel.js";
import { renderTemplate } from "./template.js";
import type {
  Envelope,
  EventTriggerReplySpec,
  EventTriggerResource,
  RenderedReply,
  TriggerTarget,
} from "./types.js";
import {
  canonicalJson,
  paramToString,
  setOwn,
  toJsonValue,
  toTypedParam,
  type CelValue,
  type JsonValue,
  type TypedParam,
} from "./values.js";

export interface CompiledParam {
  name: string;
  expression: CompiledExpression;
}

export interface CompiledTrigger {
  name: string;
  sourceRef?: string;
  priority: number;
  /** False when any CEL (match or params) fails to compile or the target is invalid. */
  ready: boolean;
  /** Why the trigger is not ready. */
  error?: string;
  /** Absent = matches every event from sourceRef. */
  match?: CompiledExpression;
  /** Sorted by name. */
  params: CompiledParam[];
  sessionKey?: string;
  target?: TriggerTarget;
  reply?: EventTriggerReplySpec;
  resource: EventTriggerResource;
}

export type SelectResult =
  | { status: "ignored" }
  | { status: "failed"; trigger: string; error: string }
  | {
      status: "matched";
      trigger: string;
      target: TriggerTarget;
      /** Typed, JSON-safe param values (int vs double pinned by `type`). */
      params: Record<string, TypedParam>;
      /** §4 string form of each param. */
      stringParams: Record<string, string>;
      /** Params as a JSON object (ints as numbers) — toolRef arguments. */
      toolArgs: Record<string, JsonValue>;
      /**
       * The tool's single string input: paramToString(params.input) when the
       * only param is named `input`, else the params as compact sorted JSON
       * ("{}" when there are none).
       */
      toolInput: string;
      sessionId: string;
      /** Rendered promptTemplate, "" when absent. */
      prompt: string;
      reply: RenderedReply | null;
    };

export interface SelectOptions {
  /** `/invoke`'s `session_id`; used when the trigger has no sessionKey. */
  callerSessionId?: string;
  /** Called for every match-evaluation error / non-bool result (a non-match). */
  onMatchError?: (trigger: string, error: string) => void;
}

function resolveTarget(resource: EventTriggerResource): TriggerTarget | string {
  const t = resource.spec?.target;
  if (!t) return "spec.target is required";
  const kinds: Array<[TriggerTarget["kind"], string | undefined]> = [];
  if (t.orchestrator !== undefined && t.orchestrator !== null) kinds.push(["orchestrator", undefined]);
  if (t.skillRef) kinds.push(["skill", t.skillRef]);
  if (t.agentRef) kinds.push(["agent", t.agentRef]);
  if (t.toolRef) kinds.push(["tool", t.toolRef]);
  if (kinds.length !== 1) {
    return "spec.target must set exactly one of orchestrator, skillRef, agentRef, toolRef";
  }
  const [kind, ref] = kinds[0]!;
  if (kind !== "tool" && !t.promptTemplate) {
    return "spec.target.promptTemplate is required unless toolRef is set";
  }
  const target: TriggerTarget = { kind, readOnly: t.readOnly === true };
  if (ref !== undefined) target.ref = ref;
  if (t.promptTemplate) target.promptTemplate = t.promptTemplate;
  return target;
}

/**
 * Compiles an EventTrigger. A trigger whose match or params CEL does not
 * compile, whose match is statically non-bool, or whose target is not exactly
 * one kind is not ready and never matches (fail-closed).
 */
export function compileTrigger(resource: EventTriggerResource): CompiledTrigger {
  const spec = resource.spec ?? ({} as EventTriggerResource["spec"]);
  const compiled: CompiledTrigger = {
    name: resource.metadata?.name ?? "",
    priority: typeof spec.priority === "number" ? spec.priority : 0,
    ready: false,
    params: [],
    resource,
  };
  if (spec.sourceRef) compiled.sourceRef = spec.sourceRef;
  if (spec.sessionKey) compiled.sessionKey = spec.sessionKey;
  if (spec.reply) compiled.reply = spec.reply;

  const notReady = (error: string): CompiledTrigger => {
    compiled.ready = false;
    compiled.error = error;
    return compiled;
  };

  if (!compiled.name) return notReady("metadata.name is required");

  const target = resolveTarget(resource);
  if (typeof target === "string") return notReady(target);
  compiled.target = target;

  const matchSrc = spec.match?.cel;
  if (matchSrc !== undefined && matchSrc.trim() !== "") {
    const c = compileExpression(matchSrc);
    if (!c.ok) return notReady(`match.cel: ${c.error}`);
    if (c.expression.resultType !== "bool" && c.expression.resultType !== "dyn") {
      return notReady(`match.cel must yield bool, got ${c.expression.resultType}`);
    }
    compiled.match = c.expression;
  }

  for (const name of Object.keys(spec.params ?? {}).sort()) {
    const src = spec.params![name]!;
    const c = compileExpression(src);
    if (!c.ok) return notReady(`params.${name}: ${c.error}`);
    compiled.params.push({ name, expression: c.expression });
  }

  compiled.ready = true;
  return compiled;
}

/** Highest priority first, then lexicographically smallest name. */
function byPrecedence(a: CompiledTrigger, b: CompiledTrigger): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Digits only and > 0 — the Temporal engine applies the identical rule, so
// "007" renders to 7 in both and "+7", "7.0", "1e3" or " 7" fail in both.
const ISSUE_NUMBER = /^[0-9]+$/;

function renderReply(
  spec: EventTriggerReplySpec | undefined,
  params: Record<string, CelValue>,
): RenderedReply | null | string {
  if (!spec || (!spec.github && !spec.http)) return null;
  const out: RenderedReply = {};
  if (spec.github) {
    const g = spec.github;
    const issue = renderTemplate(g.issueNumber ?? "", params);
    if (!ISSUE_NUMBER.test(issue) || !Number.isSafeInteger(Number(issue)) || Number(issue) === 0) {
      return `reply.github.issueNumber rendered to ${JSON.stringify(issue)}, not a positive integer`;
    }
    const github: NonNullable<RenderedReply["github"]> = {
      repository: renderTemplate(g.repository ?? "", params),
      issueNumber: Number(issue),
    };
    if (g.ack) github.ack = renderTemplate(g.ack, params);
    if (g.sessionPage) github.sessionPage = true;
    if (g.result) github.result = true;
    if (g.removeLabel) github.removeLabel = renderTemplate(g.removeLabel, params);
    out.github = github;
  }
  if (spec.http) {
    // The URL is LITERAL — never templated (SSRF).
    out.http = { url: spec.http.url };
    if (spec.http.secretRef) out.http.secretRef = { ...spec.http.secretRef };
  }
  return out;
}

/**
 * Picks the single winning trigger for an envelope and resolves its params,
 * templates, session id and reply (§4). Never throws.
 */
export function selectTrigger(
  triggers: readonly CompiledTrigger[],
  envelope: Envelope,
  options: SelectOptions = {},
): SelectResult {
  const activation = prepareActivation(envelope);
  const candidates = triggers
    .filter((t) => t.ready && t.target && (!t.sourceRef || t.sourceRef === envelope.source))
    .sort(byPrecedence);

  let winner: CompiledTrigger | undefined;
  for (const t of candidates) {
    if (!t.match) {
      winner = t;
      break;
    }
    const r = evaluate(t.match, activation);
    if (!r.ok) {
      options.onMatchError?.(t.name, r.error);
      continue;
    }
    if (typeof r.value !== "boolean") {
      options.onMatchError?.(t.name, `match.cel yielded a non-bool value`);
      continue;
    }
    if (r.value) {
      winner = t;
      break;
    }
  }
  if (!winner) return { status: "ignored" };

  const fail = (error: string): SelectResult => ({ status: "failed", trigger: winner!.name, error });

  const raw: Record<string, CelValue> = {};
  const params: Record<string, TypedParam> = {};
  const stringParams: Record<string, string> = {};
  const toolArgs: Record<string, JsonValue> = {};
  try {
    for (const p of winner.params) {
      const r = evaluate(p.expression, activation);
      if (!r.ok) return fail(`params.${p.name}: ${r.error}`);
      setOwn(raw, p.name, r.value);
      setOwn(params, p.name, toTypedParam(r.value));
      setOwn(stringParams, p.name, paramToString(r.value));
      setOwn(toolArgs, p.name, toJsonValue(r.value));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const names = Object.keys(raw);
  let toolInput: string;
  try {
    toolInput = names.length === 1 && names[0] === "input" ? paramToString(raw.input) : canonicalJson(raw);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const target = winner.target!;
  const prompt = target.promptTemplate ? renderTemplate(target.promptTemplate, raw) : "";

  let sessionId = winner.sessionKey ? renderTemplate(winner.sessionKey, raw) : "";
  if (!sessionId) sessionId = options.callerSessionId || `event:${envelope.source}:${envelope.id}`;

  const reply = renderReply(winner.reply, raw);
  if (typeof reply === "string") return fail(reply);

  return {
    status: "matched",
    trigger: winner.name,
    target: { ...target },
    params,
    stringParams,
    toolArgs,
    toolInput,
    sessionId,
    prompt,
    reply,
  };
}
