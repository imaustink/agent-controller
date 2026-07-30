/**
 * Turning collected form values into a *minimal* values file, plus the schema
 * helpers that both this module and render.ts need.
 *
 * A values file exists to state the delta from the chart's defaults. Restating
 * a default is worse than noise: it pins a value the chart author intended to
 * be free to change on the next bump. So every leaf that matches its schema
 * default is dropped, and every container left empty by that pruning is
 * dropped too.
 *
 * (The schema helpers live here rather than in their own module because
 * prune.ts is the schema-walking half of the renderer -- render.ts imports
 * them from here.)
 */

import type { Json, JSONSchema, JsonSchemaType, SubSchema } from "./types.js";

/**
 * Normalizes a draft-07 subschema.
 *
 * `false` means "nothing is valid here", which for a property means the field is
 * forbidden -- an `if`/`then` branch turning off `port` for a cron workload
 * writes exactly that. It returns null so callers skip the field rather than
 * rendering a control for something the schema rejects. `true` is the empty
 * schema: no constraints.
 */
export function asSchema(v: SubSchema | undefined): JSONSchema | null {
  if (v === undefined || v === false) return null;
  if (v === true) return {};
  return typeof v === "object" && !Array.isArray(v) ? v : null;
}

// --- schema helpers --------------------------------------------------------

/** Chart authors use both spellings; draft-07 said `definitions`, 2019-09 said `$defs`. */
function defsOf(root: JSONSchema): Record<string, JSONSchema> {
  return { ...(root.definitions ?? {}), ...(root.$defs ?? {}) };
}

/**
 * Follows local `$ref` chains to the schema they name.
 *
 * Remote refs (anything not starting `#/`) return null: fetching them would
 * mean a network call from a sandboxed iframe with an opaque origin, which is
 * both impossible in practice and not something we want to depend on. The
 * caller renders the unsupported fallback instead.
 */
export function resolveRef(schema: JSONSchema, root: JSONSchema, seen = new Set<string>()): JSONSchema | null {
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (seen.has(ref)) return null; // cyclic $ref; charts do this by accident
  seen.add(ref);

  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/").map(decodeRefToken);
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;

  const target = node as JSONSchema;
  // Sibling keywords alongside a $ref are ignored by draft-07, but `title` and
  // `description` written next to one are almost always meant to win.
  const merged: JSONSchema = { ...target };
  if (schema.title !== undefined) merged.title = schema.title;
  if (schema.description !== undefined) merged.description = schema.description;
  if (schema.default !== undefined) merged.default = schema.default;
  return target.$ref ? resolveRef(merged, root, seen) : merged;
}

function decodeRefToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Collapses `anyOf`/`oneOf` when every branch is a scalar, which is the only
 * form we can render honestly: there is no UI here for "pick a branch".
 * Returns null when the branches disagree structurally, so the caller falls
 * back to unsupported.
 */
export function collapseUnion(schema: JSONSchema, root: JSONSchema): JSONSchema | null {
  const branches = schema.anyOf ?? schema.oneOf;
  if (!branches || branches.length === 0) return schema;

  const resolved: JSONSchema[] = [];
  for (const b of branches) {
    const r = resolveRef(b, root);
    if (!r) return null;
    resolved.push(r);
  }

  // A `["string", "null"]`-equivalent union spelled out as anyOf branches is
  // extremely common; treat a null-typed branch as the nullable marker.
  const nonNull = resolved.filter((b) => !isOnlyNull(b));
  if (nonNull.length === 0) return null;

  const first = nonNull[0]!;
  const allScalar = nonNull.every((b) => {
    const t = typeOf(b);
    return t !== null && t !== "object" && t !== "array";
  });
  if (!allScalar) return null;

  // Render as the first branch, keeping the parent's own annotations.
  const out: JSONSchema = { ...first };
  if (schema.title !== undefined) out.title = schema.title;
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.default !== undefined) out.default = schema.default;
  if (resolved.length !== nonNull.length) out.type = [typeOf(first)!, "null"];
  delete out.anyOf;
  delete out.oneOf;
  return out;
}

function isOnlyNull(s: JSONSchema): boolean {
  return s.type === "null" || (Array.isArray(s.type) && s.type.every((t) => t === "null"));
}

/** The declared type, taking the first non-`null` entry of the array form. */
export function typeOf(schema: JSONSchema): JsonSchemaType | null {
  const t = schema.type;
  if (typeof t === "string") return t === "null" ? null : t;
  if (Array.isArray(t)) {
    const first = t.find((x) => x !== "null");
    return first ?? null;
  }
  // No `type` at all. Infer from the keywords present, which real charts rely
  // on more than they should.
  if (schema.properties || schema.additionalProperties !== undefined) return "object";
  if (schema.items) return "array";
  if (schema.enum) return "string";
  return null;
}

/** True when `null` is an accepted value -- the `["string", "null"]` idiom. */
export function isNullable(schema: JSONSchema): boolean {
  const t = schema.type;
  if (Array.isArray(t)) return t.includes("null");
  return t === "null";
}

/** A free-form map (`podAnnotations`, `nodeSelector`) rather than a fixed object. */
export function isOpenMap(schema: JSONSchema): boolean {
  if (schema.properties && Object.keys(schema.properties).length > 0) return false;
  return schema.additionalProperties === true || isSchemaObject(schema.additionalProperties);
}

function isSchemaObject(v: unknown): v is JSONSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves a dotted allowlist path (`resources.limits.cpu`) to its schema
 * node, or null if any segment is missing. Null is a hard error at the call
 * site, never a silent skip: a path that stopped resolving is how you find out
 * a chart bump moved a field out from under the allowlist.
 */
export function resolvePath(root: JSONSchema, path: string): JSONSchema | null {
  let node: JSONSchema | null = resolveRef(root, root);
  for (const seg of path.split(".")) {
    if (!node) return null;
    node = collapseUnion(node, root);
    if (!node) return null;
    const props = node.properties;
    const next = props ? props[seg] : undefined;
    const normalized = asSchema(next);
    if (!normalized) {
      // Either the segment is not a property at all -- a path into a free-form
      // map's key space, like `podAnnotations.foo` -- or it is a property the
      // schema forbids (`false`). Allowlisting either is meaningless, so both
      // stay errors.
      return null;
    }
    node = resolveRef(normalized, root);
  }
  return node;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    // Key order is irrelevant to equality even though it matters to emission.
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

// --- pruning ---------------------------------------------------------------

/**
 * "Nothing was entered here." Distinct from a meaningful `false` or `0`, which
 * are real choices and always survive.
 */
function isEmptyish(v: Json): boolean {
  if (v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/**
 * The minimal override object for `values` against `schema`.
 *
 * Key order follows the schema's `properties` order, which is what makes the
 * emitted YAML stable enough to commit -- see the note in yaml.ts.
 */
export function pruneToOverrides(
  values: Record<string, Json>,
  schema: JSONSchema,
): Record<string, Json> {
  const root = schema;
  const out = pruneObject(values, schema, root);
  return out ?? {};
}

function pruneObject(
  values: Record<string, Json>,
  schema: JSONSchema,
  root: JSONSchema,
): Record<string, Json> | null {
  const out: Record<string, Json> = {};
  const props = schema.properties ?? {};

  // Schema order first...
  for (const key of Object.keys(props)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const normalized = asSchema(props[key]);
    const child = normalized ? resolveRef(normalized, root) : null;
    const kept = pruneNode(values[key]!, child, root);
    if (kept !== DROP) out[key] = kept;
  }
  // ...then anything the user keyed themselves, in the order they added it.
  for (const key of Object.keys(values)) {
    if (Object.prototype.hasOwnProperty.call(props, key)) continue;
    const kept = pruneNode(values[key]!, null, root);
    if (kept !== DROP) out[key] = kept;
  }

  return Object.keys(out).length === 0 ? null : out;
}

/** Sentinel: distinguishes "drop this key" from a legitimate `null` value. */
const DROP = Symbol("drop");

function pruneNode(value: Json, schema: JSONSchema | null, root: JSONSchema): Json | typeof DROP {
  const resolved = schema ? collapseUnion(schema, root) : null;
  const def = resolved?.default;

  // A value identical to the chart's default carries no information.
  if (def !== undefined && deepEqual(value, def)) return DROP;

  // Structural recursion only for fixed objects. A free-form map is a leaf: its
  // keys are the user's, not the schema's, so there is nothing to walk and its
  // `default` (usually `{}`) applies to the map as a whole.
  const structural =
    resolved !== null &&
    !isOpenMap(resolved) &&
    typeOf(resolved) === "object" &&
    isPlainJsonObject(value);

  if (structural) {
    const pruned = pruneObject(value as Record<string, Json>, resolved, root);
    // An object emptied by pruning its children is itself nothing to say.
    return pruned ?? DROP;
  }

  // An explicit null where the schema permits null is a choice, not an absence.
  // The renderer only ever produces null from a deliberate "set to null" toggle
  // -- a field left alone reads as "" or as nothing at all -- and a schema that
  // lists "null" among a field's valid types is saying null means something
  // here. `autoscaling: null` on a workload is the case that matters: it is how
  // you turn autoscaling off, and dropping it silently leaves it on.
  if (value === null && resolved !== null && isNullable(resolved)) return value;

  // Other emptiness with no default to differ from means "left blank", not an
  // override. With a default it is the opposite: clearing a field the chart
  // populates is exactly the kind of thing that must survive.
  if (def === undefined && isEmptyish(value)) return DROP;

  // Untyped objects reaching here (free-form maps, or values with no schema)
  // still get their empty children dropped so `{a: {}}` does not survive.
  if (isPlainJsonObject(value)) {
    const compacted = compactUntyped(value);
    if (compacted === null) return def === undefined ? DROP : {};
    return compacted;
  }

  return value;
}

function isPlainJsonObject(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Drops empty-ish leaves from a schema-less map, then the map if nothing is left. */
function compactUntyped(obj: { [k: string]: Json }): { [k: string]: Json } | null {
  const out: Record<string, Json> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key]!;
    if (isPlainJsonObject(v)) {
      const inner = compactUntyped(v);
      if (inner !== null) out[key] = inner;
      continue;
    }
    if (isEmptyish(v)) continue;
    out[key] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}
