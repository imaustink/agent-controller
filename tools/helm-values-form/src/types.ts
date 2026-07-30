/**
 * The slice of JSON Schema draft-07 that Helm charts actually use in
 * `values.schema.json`, plus the config envelope the HTML shell injects.
 *
 * This is deliberately a subset. Anything outside it renders as a disabled
 * "Unsupported field type" control rather than throwing -- see render.ts. The
 * schemas come from upstream charts we do not control, so the renderer treats
 * every field as potentially unrenderable and never lets one bad node blank the
 * whole iframe.
 */

/** A JSON value, as it appears in `default`, `enum`, and `const`. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/**
 * draft-07 allows a boolean anywhere a subschema is allowed: `true` accepts
 * everything, `false` accepts nothing. `properties: { port: false }` is the
 * standard way an `if`/`then` branch says "this field is forbidden for this
 * variant", so the boolean form is load-bearing here, not a curiosity. Use
 * `asSchema` (prune.ts) to normalize one.
 */
export type SubSchema = JSONSchema | boolean;

export interface JSONSchema {
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
  definitions?: Record<string, JSONSchema>;

  /**
   * Draft-07 allows a single type or a list. `["string", "null"]` is the
   * standard nullable idiom and shows up throughout real charts, so the
   * array form is a first-class case here, not a curiosity.
   */
  type?: JsonSchemaType | JsonSchemaType[];

  title?: string;
  description?: string;
  default?: Json;

  // object
  properties?: Record<string, SubSchema>;
  required?: string[];
  /**
   * `true` or a schema means "arbitrary user-chosen keys" -- how charts model
   * podAnnotations, nodeSelector, extraEnv. `false`/absent means closed.
   */
  additionalProperties?: SubSchema;
  /**
   * Constrains the *keys* of a free-form map -- `pattern`, `maxLength`,
   * `minLength`. Applied to the key inputs of every map editor.
   */
  propertyNames?: JSONSchema;
  minProperties?: number;
  maxProperties?: number;

  // array
  items?: SubSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;

  // string
  enum?: Json[];
  const?: Json;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // number / integer
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  /**
   * Carries the `if`/`then` clauses that make a field set depend on a
   * discriminator (`kind: cron` forbids `port`, requires `schedule`). See
   * `conditionals()` in render.ts.
   */
  allOf?: JSONSchema[];
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;

  /** Charts sometimes carry a version marker; we surface it in the YAML header. */
  $schema?: string;
  version?: string;

  [k: string]: unknown;
}

/**
 * Everything the iframe gets. There is no other channel: `window.args` is only
 * injected when the user has turned on same-origin access, which is off by
 * default, so this struct arrives through the `/*__CONFIG__*\/` marker in the
 * shell and nothing else.
 */
export interface FormConfig {
  /** Chart name, used in the YAML header comment and the submitted message. */
  chart: string;
  /** Human-facing form heading. Falls back to `chart`. */
  title?: string;
  /** Optional blurb under the heading. */
  description?: string;
  /**
   * The schema, already pruned to `include` by the Python side (it has to
   * prune before it can enforce the config byte budget). Kept as the full
   * draft-07 shape so `$defs` referenced by surviving fields still resolve.
   */
  schema: JSONSchema;
  /**
   * The allowlist as written in `<chart>.form.json`, passed through verbatim.
   * The renderer re-resolves every path against `schema` and refuses to render
   * if one is missing -- that is the tripwire for an allowlist gone stale
   * against a bumped chart.
   */
  include?: string[];
  /** Label on the submit button. */
  submitLabel?: string;
  /** Chart version, for the generated-by comment. */
  chartVersion?: string;
}

/** What `render()` hands back to the shell on a valid submit. */
export type SubmitHandler = (yaml: string, values: Record<string, Json>) => void;
