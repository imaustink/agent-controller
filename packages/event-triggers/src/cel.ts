// The shared CEL environment (docs/event-triggers.md §3), on @marcbachmann/cel-js.
//
// Parity notes vs cel-go (the Temporal engine):
// - Variables are declared with the contract's types; unknown variables are a
//   compile error (cel-js's parse() alone would defer that to evaluation, so
//   compileExpression always type-checks).
// - homogeneousAggregateLiterals is OFF: cel-go accepts `[1, "a"]` by default.
// - JSON numbers are normalized (integral → int) before evaluation.

import { Environment, type ParseResult } from "@marcbachmann/cel-js";
import type { Envelope } from "./types.js";
import { normalizeJson, type CelValue } from "./values.js";

const env = new Environment({ homogeneousAggregateLiterals: false })
  .registerVariable("source", "string")
  .registerVariable("kind", "string")
  .registerVariable("id", "string")
  .registerVariable("time", "string")
  .registerVariable("repository", "string")
  .registerVariable("headers", "map<string, string>")
  .registerVariable("body", "dyn")
  .registerVariable("sender", "map<string, dyn>");

export interface CompiledExpression {
  readonly source: string;
  /** Statically checked result type ("bool", "int", "dyn", ...). */
  readonly resultType: string;
  /** @internal */
  readonly program: ParseResult;
}

export type CompileResult =
  | { ok: true; expression: CompiledExpression }
  | { ok: false; error: string };

export type EvaluateResult = { ok: true; value: CelValue } | { ok: false; error: string };

/** The CEL activation for an envelope: every declared variable is bound. */
export type Activation = Record<string, CelValue>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

/** Parses and type-checks `expr` against the contract's environment. */
export function compileExpression(expr: string): CompileResult {
  let program: ParseResult;
  try {
    program = env.parse(expr);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  let checked;
  try {
    checked = program.check();
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (!checked.valid) return { ok: false, error: errorMessage(checked.error) };
  return { ok: true, expression: { source: expr, resultType: checked.type ?? "dyn", program } };
}

/** Builds the activation (normalizes JSON numbers, fills absent fields). */
export function envelopeActivation(envelope: Envelope): Activation {
  return {
    source: envelope.source ?? "",
    kind: envelope.kind ?? "",
    id: envelope.id ?? "",
    time: envelope.time ?? "",
    repository: envelope.repository ?? "",
    headers: normalizeJson(envelope.headers ?? {}),
    body: normalizeJson(envelope.body ?? {}),
    sender: normalizeJson(envelope.sender ?? {}),
  };
}

function isActivation(value: Envelope | Activation): value is Activation {
  return ACTIVATION.has(value as object);
}
const ACTIVATION = new WeakSet<object>();

/** Like envelopeActivation, but marked so evaluate() won't re-normalize it. */
export function prepareActivation(envelope: Envelope): Activation {
  const activation = envelopeActivation(envelope);
  ACTIVATION.add(activation);
  return activation;
}

/**
 * Evaluates an expression (source or compiled) against an envelope (or an
 * activation from prepareActivation). Never throws.
 */
export function evaluate(
  exprOrCompiled: string | CompiledExpression,
  envelope: Envelope | Activation,
): EvaluateResult {
  let compiled: CompiledExpression;
  if (typeof exprOrCompiled === "string") {
    const c = compileExpression(exprOrCompiled);
    if (!c.ok) return c;
    compiled = c.expression;
  } else {
    compiled = exprOrCompiled;
  }
  const activation = isActivation(envelope) ? envelope : envelopeActivation(envelope as Envelope);
  try {
    const value = compiled.program(activation) as unknown;
    if (value instanceof Promise) {
      // Only async custom functions return promises; we register none.
      return { ok: false, error: "unexpected asynchronous CEL result" };
    }
    return { ok: true, value: value as CelValue };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
