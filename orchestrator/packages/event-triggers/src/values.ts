// Value model shared by the CEL evaluator, params and templates
// (docs/event-triggers.md §3-§4).
//
// Inside this package a CEL value is represented the way @marcbachmann/cel-js
// represents it: `int` is a `bigint`, `double` is a `number`, `string`,
// `bool`, `null`, a list is an array and a map is a plain object (we build
// null-prototype objects so a payload key such as "__proto__" is just data).
// Outside the package everything is JSON (`JsonValue`) plus an explicit type
// tag where JSON cannot carry the int/double distinction (`TypedParam`).

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A CEL runtime value as produced/consumed by the evaluator. */
export type CelValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | CelValue[]
  | { [key: string]: CelValue };

/** The CEL type names this package distinguishes; anything else is "unsupported". */
export type CelTypeName =
  | "int"
  | "double"
  | "string"
  | "bool"
  | "list"
  | "map"
  | "null"
  | "unsupported";

/** A param value in JSON-safe form, with its CEL type pinned (int vs double). */
export interface TypedParam {
  value: JsonValue;
  type: Exclude<CelTypeName, "unsupported">;
}

const INT64_MIN = -9223372036854775808;
const INT64_LIMIT = 9223372036854775808; // exclusive upper bound (2^63)

/** Defines an own enumerable property even for keys like "__proto__". */
export function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Converts parsed JSON into CEL values: an integral number (within int64)
 * becomes a CEL `int` (bigint), any other number a CEL `double`. Integrality is
 * decided on the VALUE, so JSON `1.0` and `1e3` are ints — JSON.parse cannot
 * tell them apart from `1` / `1000`, and the Go engine follows the same rule.
 */
export function normalizeJson(value: unknown): CelValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
    case "bigint":
      return value;
    case "number":
      if (Number.isInteger(value) && value >= INT64_MIN && value < INT64_LIMIT) {
        return BigInt(value);
      }
      return value;
    case "object": {
      if (Array.isArray(value)) return value.map((v) => normalizeJson(v));
      const out = Object.create(null) as Record<string, CelValue>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        out[k] = normalizeJson(v);
      }
      return out;
    }
    default:
      throw new TypeError(`normalizeJson: unsupported ${typeof value}`);
  }
}

/** The CEL type of a runtime value (types outside the parity subset are "unsupported"). */
export function celTypeOf(value: unknown): CelTypeName {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return "int";
    case "number":
      return "double";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "object":
      if (Array.isArray(value)) return "list";
      if (isPlainMap(value)) return "map";
      return "unsupported"; // uint, bytes, timestamp, duration, type, optional
    default:
      return "unsupported";
  }
}

export class UnsupportedValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedValueError";
  }
}

/**
 * Converts a CEL value into JSON: ints become numbers (precision is only exact
 * up to 2^53), maps become plain objects. Values outside the subset (uint,
 * bytes, timestamp, duration, type) and non-finite doubles are rejected —
 * a param must be representable as JSON.
 */
export function toJsonValue(value: unknown): JsonValue {
  switch (celTypeOf(value)) {
    case "null":
      return null;
    case "int":
      return Number(value as bigint);
    case "double":
      if (!Number.isFinite(value as number)) {
        throw new UnsupportedValueError(`non-finite double ${String(value)} is not representable as JSON`);
      }
      return value as number;
    case "string":
    case "bool":
      return value as string | boolean;
    case "list":
      return (value as unknown[]).map((v) => toJsonValue(v));
    case "map": {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, k, toJsonValue(v));
      return out;
    }
    default:
      throw new UnsupportedValueError(`unsupported CEL value type ${describe(value)}`);
  }
}

/** JSON-safe value + pinned CEL type. */
export function toTypedParam(value: unknown): TypedParam {
  const type = celTypeOf(value);
  if (type === "unsupported") throw new UnsupportedValueError(`unsupported CEL value type ${describe(value)}`);
  return { value: toJsonValue(value), type };
}

/** Inverse of toTypedParam: rebuilds the CEL value (int → bigint, double → number). */
export function fromTypedParam(param: TypedParam): CelValue {
  switch (param.type) {
    case "int":
      if (typeof param.value !== "number" || !Number.isInteger(param.value)) {
        throw new TypeError(`fromTypedParam: int param must be an integral number`);
      }
      return BigInt(param.value);
    case "double":
      if (typeof param.value !== "number") throw new TypeError(`fromTypedParam: double param must be a number`);
      return param.value;
    default:
      return normalizeJson(param.value);
  }
}

function describe(value: unknown): string {
  if (value !== null && typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}

function formatDouble(n: number): string {
  if (!Number.isFinite(n)) {
    throw new UnsupportedValueError(`non-finite double ${String(n)} is not representable`);
  }
  // ECMAScript Number#toString: shortest round-trip digits, "5" for 5.0,
  // exponent form "1e+21" / "1e-7" outside [1e-6, 1e21). -0 renders "0".
  return String(n);
}

/**
 * Compact JSON with map keys sorted (by UTF-16 code unit, which equals byte
 * order for the ASCII keys events carry) at every level. Ints are written
 * exactly from the bigint, doubles via Number#toString. Strings use
 * JSON.stringify escaping — no HTML escaping of <, >, &.
 */
export function canonicalJson(value: unknown): string {
  switch (celTypeOf(value)) {
    case "null":
      return "null";
    case "int":
      return (value as bigint).toString();
    case "double":
      return formatDouble(value as number);
    case "string":
      return JSON.stringify(value);
    case "bool":
      return value ? "true" : "false";
    case "list":
      return `[${(value as unknown[]).map((v) => canonicalJson(v)).join(",")}]`;
    case "map": {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new UnsupportedValueError(`unsupported CEL value type ${describe(value)}`);
  }
}

/**
 * A param's string form for templates (§4): string as-is, int in decimal,
 * double in shortest round-trip form (ECMAScript Number#toString), bool
 * true/false, null "", list/map as compact JSON with sorted keys.
 */
export function paramToString(value: unknown): string {
  switch (celTypeOf(value)) {
    case "null":
      return "";
    case "string":
      return value as string;
    case "int":
      return (value as bigint).toString();
    case "double":
      return formatDouble(value as number);
    case "bool":
      return value ? "true" : "false";
    default:
      return canonicalJson(value);
  }
}
