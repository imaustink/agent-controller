/**
 * JSON Schema -> DOM, validation, and submit.
 *
 * Three rules shape every line of this file:
 *
 *  1. No `innerHTML`, ever. Titles, descriptions and enum values come from
 *     upstream schemas nobody here controls, so everything schema-derived goes
 *     in through `textContent`.
 *  2. No `<form>` and no `type="submit"`. Form submission inside an Open WebUI
 *     embed is gated behind a per-user setting that defaults to off, so a real
 *     submit silently does nothing for most users. It is a plain button with a
 *     click handler.
 *  3. A bad schema must never blank the iframe. Any node we cannot render
 *     honestly becomes a disabled "Unsupported field type" control, and a
 *     malformed root becomes an error banner -- never a thrown exception and an
 *     empty box.
 *
 * ## Groups
 *
 * Bindings are grouped, and a binding's `path` is relative to its own group. A
 * plain object section is *inline*: its fields join the parent group with an
 * extended path prefix. Anything whose contents can appear, disappear, or be
 * repeated -- array cards, map entries, a conditional field set, a nullable
 * object -- owns its own group and exposes a single binding upward that reads,
 * validates and focuses into it.
 *
 * That indirection is what makes arbitrary nesting work. An array of objects
 * whose items contain their own sections and arrays is just a group inside a
 * group; there is no special case for depth, and no absolute path that goes
 * stale when row 2 is deleted.
 */

import { valuesYaml } from "./values.js";
import {
  asSchema,
  collapseUnion,
  deepEqual,
  isNullable,
  isOpenMap,
  resolvePath,
  resolveRef,
  typeOf,
} from "./prune.js";
import { CSS } from "./theme.js";
import type { FormConfig, Json, JSONSchema, JsonSchemaType, SubmitHandler } from "./types.js";

/**
 * How deep nesting is rendered before falling back to unsupported.
 *
 * Raised from 4 when containers started consuming levels: a map-of-objects or an
 * array-of-objects costs a level for its card, so a chart with `workloads.<name>.
 * image.repository` would have hit a 4-level cap that plain objects never
 * reached. 6 keeps roughly the old effective reach for a fixed-property chain
 * while leaving room for a container or two in it. The cap exists at all so a
 * pathological or recursive schema produces a visible stop rather than an
 * unusable wall of nesting.
 */
const MAX_DEPTH = 6;

/**
 * "The user entered nothing here." Distinct from the empty string and from an
 * explicit null, both of which are real values a user can mean. Absent paths
 * never reach the values object at all, which keeps a blank number input from
 * arriving at the YAML emitter as `""`.
 */
const ABSENT = Symbol("absent");
type Reading = Json | typeof ABSENT;

interface Binding {
  /** Relative to the owning group, not to the document root. */
  path: string[];
  read(): Reading;
  /**
   * Error message, or null when valid. Container bindings also write their
   * children's error text as a side effect, since that is where the user needs
   * to see it.
   */
  validate(): string | null;
  setError(msg: string | null): void;
  focus(): void;
  /** `<details>` ancestors, so a blocked submit can un-collapse them. */
  sections: HTMLDetailsElement[];
  /** See the note on the extra-keys editor in `renderProperties`. */
  merge?: boolean;
  /** Containers report how many of their descendants are actually wrong. */
  errorCount?(): number;
  /** Containers report which of their *inner* sections hold an error. */
  openSections?(): HTMLDetailsElement[];
}

interface Group {
  bindings: Binding[];
}

interface Ctx {
  /** The document root schema, for resolving `$ref`. */
  root: JSONSchema;
  /** The group new bindings are registered in. */
  group: Group;
  sections: HTMLDetailsElement[];
  /**
   * Prefix for generated control ids. Paths are group-relative, so two cards in
   * the same list both hold a field at `kind` -- without a per-card prefix they
   * would emit duplicate DOM ids and every `<label for>` would point at the first
   * card's control.
   */
  idPrefix: string;
}

export function render(root: HTMLElement, cfg: FormConfig, onSubmit: SubmitHandler): void {
  root.textContent = "";
  root.className = "hvf";

  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  root.appendChild(el("h1", "hvf-h", cfg.title || cfg.chart));
  if (cfg.description) root.appendChild(el("p", "hvf-sub", cfg.description));

  const schema = resolveRef(cfg.schema, cfg.schema);

  // A stale allowlist is the failure this check exists for: a chart bump moves
  // or renames a field, the path stops resolving, and a form that silently
  // dropped it would produce a values file missing an override the user asked
  // for. Loud and non-submittable is the only safe outcome.
  const missing = (cfg.include ?? []).filter((p) => !schema || resolvePath(schema, p) === null);
  if (missing.length > 0) {
    root.appendChild(
      banner(
        "This form's field allowlist no longer matches the chart schema.",
        `These paths in ${cfg.chart}.form.json do not resolve. The chart was probably bumped; fix the allowlist and reload.`,
        missing,
      ),
    );
    return;
  }

  if (!schema || typeOf(schema) !== "object" || !hasRenderableProps(schema)) {
    root.appendChild(
      banner(
        "This chart's schema cannot be rendered as a form.",
        schema
          ? "The root schema has no object properties. A values.schema.json needs a top-level `type: object` with `properties`."
          : "The root schema could not be resolved (an unresolvable $ref, most likely).",
      ),
    );
    return;
  }

  const group: Group = { bindings: [] };
  const ctx: Ctx = { root: schema, group, sections: [], idPrefix: "" };
  const body = el("div", "hvf-body");
  root.appendChild(body);

  const conds = conditionals(schema, schema);
  if (conds) conditionalBody(body, schema, conds, [], 0, ctx, undefined);
  else renderProperties(body, schema, [], 0, ctx, undefined);

  // --- footer -------------------------------------------------------------
  const foot = el("div", "hvf-foot");
  const btn = el("button", "hvf-b hvf-submit", cfg.submitLabel || "Generate values.yaml");
  // Explicitly not "submit": see rule 2 at the top of this file.
  (btn as HTMLButtonElement).type = "button";
  const summary = el("span", "hvf-summary");
  summary.setAttribute("role", "status");
  foot.appendChild(btn);
  foot.appendChild(summary);
  root.appendChild(foot);

  btn.addEventListener("click", () => {
    const result = validateGroup(group);
    if (result.first) {
      const n = result.count;
      summary.textContent = `${n} field${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention.`;
      // Expand the sections of *every* invalid field, not just the first one.
      // Expanding only the first hides the rest whenever the first happens to
      // sit at the top level: its section chain is empty, nothing opens, and the
      // user is told three fields need attention while looking at three
      // collapsed sections.
      for (const d of result.open) d.open = true;
      result.first.focus();
      return;
    }
    summary.textContent = "";

    // Same call scripts/helm-check.mjs makes, so what CI feeds to Helm is what
    // this button produces.
    const { yaml, overrides } = valuesYaml(readGroup(group), cfg.schema, {
      chart: cfg.chart,
      ...(cfg.chartVersion ? { chartVersion: cfg.chartVersion } : {}),
    });
    onSubmit(yaml, overrides);
  });
}

function hasRenderableProps(schema: JSONSchema): boolean {
  return Object.keys(schema.properties ?? {}).length > 0 || isOpenMap(schema);
}

// --- groups ----------------------------------------------------------------

function readGroup(group: Group): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const b of group.bindings) {
    const v = b.read();
    if (v === ABSENT) continue;
    if (b.merge && isPlainObject(v)) mergePath(out, b.path, v);
    else setPath(out, b.path, v);
  }
  return out;
}

interface GroupResult {
  count: number;
  first: Binding | null;
  open: Set<HTMLDetailsElement>;
}

/**
 * Validates every binding in a group, writing each one's error text, and reports
 * what the caller needs to react: how many are wrong, which to focus, and which
 * sections to expand. Container bindings fold their descendants' counts and
 * inner sections in through `errorCount`/`openSections`.
 */
function validateGroup(group: Group): GroupResult {
  const out: GroupResult = { count: 0, first: null, open: new Set() };
  for (const b of group.bindings) {
    const err = b.validate();
    b.setError(err);
    if (err === null) continue;
    out.count += b.errorCount ? b.errorCount() : 1;
    if (!out.first) out.first = b;
    for (const d of b.sections) out.open.add(d);
    for (const d of b.openSections?.() ?? []) out.open.add(d);
  }
  return out;
}

// --- tree walking ----------------------------------------------------------

function renderProperties(
  parent: HTMLElement,
  schema: JSONSchema,
  path: string[],
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
  skip?: Set<string>,
): void {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const seedObj = isPlainObject(seed) ? seed : undefined;

  for (const key of Object.keys(props)) {
    if (skip?.has(key)) continue;
    const sub = asSchema(props[key]);
    // `false` means the schema forbids this property here -- an if/then branch
    // switching a field off for one variant. Rendering a control for something
    // the schema rejects would invite the user to produce an invalid file.
    if (!sub) continue;
    renderNode(parent, key, sub, [...path, key], required.has(key), depth, ctx, seedObj?.[key]);
  }

  // A node with both fixed properties and an open key space: render the fixed
  // ones above, then one editor for the rest. `reserved` both marks this binding
  // as a merge (its path is the node's own) and lets it reject a key that
  // already has a dedicated control.
  if (isOpenMap({ ...schema, properties: undefined }) && Object.keys(props).length > 0) {
    const valueSchema = asSchema(schema.additionalProperties) ?? {};
    const vType = typeOf(collapseUnion(valueSchema, ctx.root) ?? valueSchema);
    if (vType !== "object" && vType !== "array") {
      kvField(parent, "additionalProperties", schema, path, false, ctx, undefined, {
        label: "Additional keys",
        reserved: Object.keys(props),
      });
    }
  }
}

function renderNode(
  parent: HTMLElement,
  key: string,
  raw: JSONSchema,
  path: string[],
  required: boolean,
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const resolved = resolveRef(raw, ctx.root);
  if (!resolved) {
    // Remote $ref, or a cycle. We do not fetch: see prune.ts/resolveRef.
    unsupported(parent, key, raw, path, "this field's $ref could not be resolved locally");
    return;
  }

  // Checked before collapseUnion, which would reject these shapes: a union of a
  // scalar and a fixed constant is a real idiom ("a name, or `true` to mean
  // derive it"), and it has an obvious control.
  const constPair = constUnion(resolved, ctx.root);
  if (constPair) {
    constToggleField(parent, key, resolved, constPair, path, required, ctx, seed);
    return;
  }

  const schema = collapseUnion(resolved, ctx.root);
  if (!schema) {
    unsupported(
      parent,
      key,
      resolved,
      path,
      "its anyOf/oneOf branches are not all scalars, so there is no single control for it",
    );
    return;
  }

  const type = typeOf(schema);

  if (type === "object") {
    objectNode(parent, key, schema, path, required, depth, ctx, seed);
    return;
  }
  if (type === "array") {
    arrayField(parent, key, schema, path, required, depth, ctx, seed);
    return;
  }
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    scalarField(parent, key, schema, path, required, ctx, type, seed);
    return;
  }

  unsupported(parent, key, schema, path, `unrecognized type: ${JSON.stringify(schema.type ?? null)}`);
}

function objectNode(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  if (isOpenMap(schema)) {
    const valueSchema = asSchema(schema.additionalProperties) ?? {};
    const resolvedValue = resolveRef(valueSchema, ctx.root);
    const collapsed = resolvedValue ? collapseUnion(resolvedValue, ctx.root) : null;
    const vType = collapsed ? typeOf(collapsed) : null;

    // A map whose values are objects -- `workloads`, `dependencies`. Each entry
    // is a card with a user-chosen key and the value object's own full field set.
    if (vType === "object" && collapsed && !isOpenMap(collapsed)) {
      if (depth >= MAX_DEPTH) {
        unsupported(parent, key, schema, path, `nesting deeper than ${MAX_DEPTH} levels is not rendered`);
        return;
      }
      mapOfObjectsField(parent, key, schema, collapsed, path, required, depth, ctx, seed);
      return;
    }
    if (vType === "array") {
      unsupported(parent, key, schema, path, "map values are arrays, which has no single control");
      return;
    }
    kvField(parent, key, schema, path, required, ctx, seed);
    return;
  }

  const conds = conditionals(schema, ctx.root);
  const hasProps = Object.keys(schema.properties ?? {}).length > 0;

  if (!hasProps && !conds) {
    // A free-form object with no stated shape -- `advanced: {type: object}`.
    // There is nothing to build controls from, so the user edits it directly.
    rawObjectField(parent, key, schema, path, required, ctx, seed);
    return;
  }

  if (depth >= MAX_DEPTH) {
    unsupported(parent, key, schema, path, `nesting deeper than ${MAX_DEPTH} levels is not rendered`);
    return;
  }

  const { details, inner } = section(parent, schema, key, path);
  const nested: Ctx = { ...ctx, sections: [...ctx.sections, details] };

  // Nullable and conditional objects each need to be read or rebuilt as a unit,
  // so they get their own group; a plain object stays inline in the parent's.
  if (!isNullable(schema) && !conds) {
    renderProperties(inner, schema, path, depth + 1, nested, seed);
    return;
  }

  const group: Group = { bindings: [] };
  const ownCtx: Ctx = { ...nested, group };
  const err = el("div", "hvf-e");

  let nullBox: HTMLInputElement | null = null;
  const bodyHost = el("div", "hvf-groupbody");

  if (isNullable(schema)) {
    const lab = el("label", "hvf-null");
    nullBox = document.createElement("input");
    nullBox.type = "checkbox";
    nullBox.checked = seed === null || (seed === undefined && schema.default === null);
    lab.appendChild(nullBox);
    lab.appendChild(document.createTextNode("set to null"));
    inner.appendChild(lab);
    const sync = () => {
      bodyHost.style.display = nullBox!.checked ? "none" : "";
    };
    nullBox.addEventListener("change", sync);
    sync();
  }

  inner.appendChild(bodyHost);
  inner.appendChild(err);

  if (conds) conditionalBody(bodyHost, schema, conds, [], depth + 1, ownCtx, seed);
  else renderProperties(bodyHost, schema, [], depth + 1, ownCtx, seed);

  ctx.group.bindings.push(
    containerBinding({
      path,
      sections: ctx.sections,
      group,
      err,
      required,
      isNull: () => nullBox?.checked ?? false,
      emptyMessage: required ? "At least one field is required." : null,
    }),
  );
}

function section(
  parent: HTMLElement,
  schema: JSONSchema,
  key: string,
  path: string[],
): { details: HTMLDetailsElement; inner: HTMLElement } {
  const details = document.createElement("details");
  details.className = "hvf-sec";
  details.open = true;
  const sum = document.createElement("summary");
  sum.appendChild(document.createTextNode(labelOf(schema, key)));
  if (path.length > 1) sum.appendChild(el("span", "hvf-secpath", path.join(".")));
  details.appendChild(sum);
  const inner = el("div", "hvf-secbody");
  details.appendChild(inner);
  parent.appendChild(details);
  if (schema.description) inner.appendChild(el("p", "hvf-help", schema.description));
  return { details, inner };
}

/**
 * The single binding a container exposes to its parent group. Delegates reading,
 * validation, focus and section-expansion into its own group.
 */
function containerBinding(opts: {
  path: string[];
  sections: HTMLDetailsElement[];
  group: Group;
  err: HTMLElement;
  required: boolean;
  isNull?: () => boolean;
  emptyMessage: string | null;
}): Binding {
  let last: GroupResult = { count: 0, first: null, open: new Set() };
  return {
    path: opts.path,
    sections: opts.sections,
    read: () => {
      if (opts.isNull?.()) return null;
      const value = readGroup(opts.group);
      return Object.keys(value).length === 0 ? ABSENT : value;
    },
    validate: () => {
      if (opts.isNull?.()) return null;
      last = validateGroup(opts.group);
      if (last.first) {
        const n = last.count;
        return `${n} field${n === 1 ? "" : "s"} inside need${n === 1 ? "s" : ""} attention.`;
      }
      if (opts.emptyMessage && Object.keys(readGroup(opts.group)).length === 0) {
        return opts.emptyMessage;
      }
      return null;
    },
    setError: (m) => setError(opts.err, null, m),
    focus: () => last.first?.focus(),
    errorCount: () => last.count || 1,
    openSections: () => Array.from(last.open),
  };
}

// --- conditionals (allOf / if / then) --------------------------------------

interface Conditional {
  value: Json;
  then: JSONSchema;
}

interface Conditionals {
  /** The property every `if` clause tests -- the discriminator. */
  prop: string;
  rules: Conditional[];
}

/**
 * Recognizes the "discriminated variant" shape: an `allOf` of `if`/`then`
 * clauses that all test one property against a constant.
 *
 * This is how a schema says a `cron` workload requires `schedule` and forbids
 * `port`, or a `redis` dependency forbids `databases`. Ignoring it does not
 * produce a wrong *form* so much as a form that happily builds a file the schema
 * rejects -- which is worse, because it looks like it worked.
 *
 * Returns null for anything more general (conditions over several properties,
 * `else` branches, non-const tests). Those fall back to the unconditional field
 * set, which is the pre-existing behavior.
 */
function conditionals(schema: JSONSchema, root: JSONSchema): Conditionals | null {
  const clauses = schema.allOf;
  if (!Array.isArray(clauses) || clauses.length === 0) return null;

  let prop: string | null = null;
  const rules: Conditional[] = [];

  for (const raw of clauses) {
    const clause = resolveRef(raw, root);
    if (!clause) return null;
    // A plain allOf entry with no if/then is a constraint we do not merge; say
    // so by bailing out rather than silently applying half of it.
    if (!clause.if || clause.then === undefined) return null;
    if (clause.else !== undefined) return null;

    const tests = clause.if.properties ?? {};
    const names = Object.keys(tests);
    if (names.length !== 1) return null;
    const name = names[0]!;
    if (prop !== null && prop !== name) return null;

    const test = asSchema(tests[name]);
    if (!test) return null;
    const value =
      test.const !== undefined
        ? test.const
        : Array.isArray(test.enum) && test.enum.length === 1
          ? test.enum[0]
          : undefined;
    if (value === undefined) return null;

    const then = asSchema(clause.then);
    if (!then) return null;

    prop = name;
    rules.push({ value: value as Json, then });
  }

  if (prop === null || rules.length === 0) return null;
  // The discriminator has to be a property we can actually render a control for.
  const discriminator = asSchema((schema.properties ?? {})[prop]);
  if (!discriminator) return null;
  return { prop, rules };
}

/** The field set for one discriminator value: base, narrowed by matching `then`s. */
function applyConditionals(base: JSONSchema, conds: Conditionals, value: Json): JSONSchema {
  const properties = { ...(base.properties ?? {}) };
  const required = new Set(base.required ?? []);

  for (const rule of conds.rules) {
    if (!deepEqual(rule.value, value)) continue;
    for (const name of rule.then.required ?? []) required.add(name);
    for (const [name, sub] of Object.entries(rule.then.properties ?? {})) {
      if (sub === false) {
        delete properties[name];
        required.delete(name);
        continue;
      }
      if (sub === true) continue;
      const existing = asSchema(properties[name]);
      // Shallow merge: `then` branches narrow a field (adding a pattern, or an
      // enum subset) rather than restructuring it.
      properties[name] = existing ? { ...existing, ...sub } : sub;
    }
  }

  const out: JSONSchema = { ...base, properties, required: Array.from(required) };
  delete out.allOf;
  return out;
}

/**
 * Renders a discriminated object: the discriminator control, then a field set
 * that is rebuilt whenever it changes.
 */
function conditionalBody(
  host: HTMLElement,
  schema: JSONSchema,
  conds: Conditionals,
  path: string[],
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const discriminator = asSchema((schema.properties ?? {})[conds.prop])!;
  const required = new Set(schema.required ?? []);
  const seedObj = isPlainObject(seed) ? seed : undefined;

  const discHost = el("div", "hvf-disc");
  host.appendChild(discHost);
  const restHost = el("div", "hvf-variant");
  host.appendChild(restHost);

  renderNode(
    discHost,
    conds.prop,
    discriminator,
    [...path, conds.prop],
    required.has(conds.prop),
    depth,
    ctx,
    seedObj?.[conds.prop],
  );

  // The discriminator's own binding is the last one registered, and it is what
  // the rebuild reads to decide which variant to show.
  const discBinding = ctx.group.bindings[ctx.group.bindings.length - 1];
  const fixedCount = ctx.group.bindings.length;

  const rebuild = (carry: Json | undefined) => {
    // Everything after the discriminator belongs to the previous variant.
    ctx.group.bindings.length = fixedCount;
    restHost.textContent = "";

    const chosen = discBinding?.read();
    if (chosen === undefined || chosen === ABSENT || chosen === "" || chosen === null) {
      // Offering the unconditional field set here would show fields that some
      // variants forbid, so ask for the discriminator first.
      restHost.appendChild(
        el("p", "hvf-help", `Choose ${labelOf(discriminator, conds.prop)} to see its fields.`),
      );
      return;
    }

    const effective = applyConditionals(schema, conds, chosen as Json);
    renderProperties(
      restHost,
      effective,
      path,
      depth,
      ctx,
      carry,
      new Set([conds.prop]),
    );
  };

  discHost.addEventListener("change", () => {
    // Carry across whatever has already been entered, so switching kind does not
    // wipe the fields the two variants share.
    rebuild({ ...(seedObj ?? {}), ...readGroup(ctx.group) });
  });

  rebuild(seed);
}

// --- scalar fields ---------------------------------------------------------

function scalarField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
  type: JsonSchemaType,
  seed: Json | undefined,
): void {
  const wrap = el("div", "hvf-f");
  const err = el("div", "hvf-e");
  const dotted = path.join(".");

  if (type === "boolean") {
    const row = el("div", "hvf-cbrow");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = fieldId(ctx.idPrefix + dotted);
    box.checked = typeof seed === "boolean" ? seed : schema.default === true;
    const isSet = typeof seed === "boolean" ? () => true : touchTracker(box, schema);
    row.appendChild(box);
    row.appendChild(label(schema, key, required, box.id));
    wrap.appendChild(row);
    if (schema.description) wrap.appendChild(el("p", "hvf-help", schema.description));
    wrap.appendChild(err);
    parent.appendChild(wrap);

    ctx.group.bindings.push({
      path,
      sections: ctx.sections,
      read: () => (isSet() ? box.checked : ABSENT),
      validate: () => null,
      setError: (m) => setError(err, box, m),
      focus: () => box.focus(),
    });
    return;
  }

  const control =
    Array.isArray(schema.enum) && schema.enum.length > 0
      ? enumControl(schema, required, seed)
      : inputControl(schema, type, seed);
  control.id = fieldId(ctx.idPrefix + dotted);

  wrap.appendChild(label(schema, key, required, control.id));
  if (schema.description) wrap.appendChild(el("p", "hvf-help", schema.description));
  wrap.appendChild(control);

  // Nullable fields need a way to say "null" that is distinguishable from
  // "blank" -- clearing a text box cannot mean both.
  let nullBox: HTMLInputElement | null = null;
  if (isNullable(schema)) {
    const lab = el("label", "hvf-null");
    nullBox = document.createElement("input");
    nullBox.type = "checkbox";
    nullBox.checked = seed === null || (seed === undefined && schema.default === null);
    lab.appendChild(nullBox);
    lab.appendChild(document.createTextNode("set to null"));
    wrap.appendChild(lab);
    const sync = () => {
      control.disabled = nullBox!.checked;
    };
    nullBox.addEventListener("change", sync);
    sync();
  }

  wrap.appendChild(err);
  parent.appendChild(wrap);

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => (nullBox?.checked ? null : readScalar(control, type)),
    validate: () =>
      nullBox?.checked ? null : validateScalar(readScalar(control, type), schema, type, required),
    setError: (m) => setError(err, control, m),
    focus: () => control.focus(),
  });
}

/**
 * Answers "has this checkbox got a value worth reporting?".
 *
 * Every other control has a blank state that prune.ts can recognize -- an empty
 * text box is `""`, an empty number box is absent. A checkbox does not:
 * unchecked *is* a value. So when the schema gives no `default` to compare
 * against, prune cannot tell an untouched box from a deliberate `false`, and
 * every form would emit `false` for every boolean the user never looked at. The
 * renderer settles it here, because it is the only layer that knows whether the
 * user touched the control.
 */
function touchTracker(box: HTMLInputElement, schema: JSONSchema): () => boolean {
  // With a default present the initial state is already meaningful: prune drops
  // it if it matches and keeps it if the user flipped it.
  if (schema.default !== undefined) return () => true;
  let touched = false;
  box.addEventListener("change", () => {
    touched = true;
  });
  return () => touched;
}

function initialValue(schema: JSONSchema, seed: Json | undefined): Json | undefined {
  if (seed !== undefined) return seed;
  return schema.default;
}

function enumControl(
  schema: JSONSchema,
  required: boolean,
  seed: Json | undefined,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "hvf-sel";
  const initial = initialValue(schema, seed);
  // An empty option is what lets "nothing chosen" exist; without it a required
  // select would be silently pre-answered with whatever came first.
  if (initial === undefined || !required) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "—";
    sel.appendChild(blank);
  }
  for (const v of schema.enum ?? []) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v);
    sel.appendChild(opt);
  }
  sel.value = initial === undefined || initial === null ? "" : String(initial);
  return sel;
}

const FORMAT_TYPES: Record<string, string> = {
  date: "date",
  "date-time": "datetime-local",
  email: "email",
  uri: "url",
  url: "url",
  hostname: "text",
  ipv4: "text",
  ipv6: "text",
};

function inputControl(
  schema: JSONSchema,
  type: JsonSchemaType,
  seed: Json | undefined,
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "hvf-in";
  if (type === "number" || type === "integer") {
    input.type = "number";
    // `any` for floats so a browser does not round-trip 0.5 into a step error;
    // integer-ness is enforced by validateScalar, not by the widget.
    input.step = type === "integer" ? "1" : "any";
    if (typeof schema.minimum === "number") input.min = String(schema.minimum);
    if (typeof schema.maximum === "number") input.max = String(schema.maximum);
  } else {
    input.type = (schema.format && FORMAT_TYPES[schema.format]) || "text";
  }
  const initial = initialValue(schema, seed);
  if (initial !== undefined && initial !== null) input.value = String(initial);
  if (schema.default !== undefined && schema.default !== null) {
    input.placeholder = String(schema.default);
  }
  return input;
}

type Control = HTMLInputElement | HTMLSelectElement;

function readScalar(control: Control, type: JsonSchemaType): Reading {
  const raw = control.value;
  if (type === "number" || type === "integer") {
    if (raw.trim() === "") return ABSENT;
    const n = Number(raw);
    // Not a number: hand the raw string back so validateScalar can complain
    // about it. It can never reach the emitter -- validation blocks submit.
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

function validateScalar(
  value: Reading,
  schema: JSONSchema,
  type: JsonSchemaType,
  required: boolean,
): string | null {
  const blank = value === ABSENT || value === "";
  if (blank) return required ? "Required." : null;

  if (type === "number" || type === "integer") {
    if (typeof value !== "number") return "Must be a number.";
    if (type === "integer" && !Number.isInteger(value)) return "Must be a whole number.";
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `Must be ${schema.minimum} or more.`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `Must be ${schema.maximum} or less.`;
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return `Must be greater than ${schema.exclusiveMinimum}.`;
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return `Must be less than ${schema.exclusiveMaximum}.`;
    }
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const q = value / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) return `Must be a multiple of ${schema.multipleOf}.`;
    }
    return null;
  }

  return validateString(String(value), schema);
}

/** Shared by scalar controls and by the *keys* of every map editor. */
function validateString(s: string, schema: JSONSchema): string | null {
  if (typeof schema.minLength === "number" && s.length < schema.minLength) {
    return `Must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}.`;
  }
  if (typeof schema.maxLength === "number" && s.length > schema.maxLength) {
    return `Must be at most ${schema.maxLength} character${schema.maxLength === 1 ? "" : "s"}.`;
  }
  if (typeof schema.pattern === "string" && schema.pattern !== "") {
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      // A schema pattern that is not a JS regex (Go's RE2 allows a few things
      // JS does not). Unenforceable here; do not fail the user for it.
      re = null;
    }
    if (re && !re.test(s)) return `Must match ${schema.pattern}`;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((e) => String(e) === s)) return "Not one of the allowed values.";
  }
  return null;
}

// --- a scalar, or a fixed constant -----------------------------------------

interface ConstPair {
  scalar: JSONSchema;
  scalarType: JsonSchemaType;
  constValue: Json;
}

/**
 * Recognizes `oneOf: [<scalar>, {const: X}]` -- "a name, or `true` to derive
 * one". The control is a checkbox for the constant plus the scalar's own input.
 */
function constUnion(schema: JSONSchema, root: JSONSchema): ConstPair | null {
  const branches = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return null;

  const resolved: JSONSchema[] = [];
  for (const b of branches) {
    const r = resolveRef(b, root);
    if (!r) return null;
    resolved.push(r);
  }

  const constBranch = resolved.find((b) => b.const !== undefined && b.type === undefined);
  const scalar = resolved.find((b) => b !== constBranch);
  if (!constBranch || !scalar) return null;

  const t = typeOf(scalar);
  if (!t || t === "object" || t === "array") return null;
  return { scalar, scalarType: t, constValue: constBranch.const as Json };
}

function constToggleField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  pair: ConstPair,
  path: string[],
  required: boolean,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const wrap = el("div", "hvf-f");
  const err = el("div", "hvf-e");

  const control = inputControl(pair.scalar, pair.scalarType, undefined);
  control.id = fieldId(ctx.idPrefix + path.join("."));
  wrap.appendChild(label(schema, key, required, control.id));
  if (schema.description) wrap.appendChild(el("p", "hvf-help", schema.description));
  wrap.appendChild(control);

  const toggleRow = el("label", "hvf-null");
  const box = document.createElement("input");
  box.type = "checkbox";
  toggleRow.appendChild(box);
  toggleRow.appendChild(document.createTextNode(`use ${JSON.stringify(pair.constValue)}`));
  wrap.appendChild(toggleRow);
  wrap.appendChild(err);
  parent.appendChild(wrap);

  const initial = initialValue(schema, seed);
  if (deepEqual(initial, pair.constValue)) box.checked = true;
  else if (initial !== undefined && initial !== null) control.value = String(initial);

  const sync = () => {
    control.disabled = box.checked;
  };
  box.addEventListener("change", sync);
  sync();

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => (box.checked ? pair.constValue : readScalar(control, pair.scalarType)),
    validate: () =>
      box.checked ? null : validateScalar(readScalar(control, pair.scalarType), pair.scalar, pair.scalarType, required),
    setError: (m) => setError(err, control, m),
    focus: () => (box.checked ? box.focus() : control.focus()),
  });
}

// --- free-form objects -----------------------------------------------------

/**
 * An object with no declared shape. There is nothing to build controls from, so
 * the user edits it directly -- as JSON, because `JSON.parse` gives real
 * validation for free and YAML would need a parser this bundle does not carry.
 * The parsed value goes through the normal emitter, so it comes out as YAML.
 */
function rawObjectField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const wrap = el("div", "hvf-f");
  const err = el("div", "hvf-e");
  const area = document.createElement("textarea");
  area.className = "hvf-in hvf-ta";
  area.rows = 4;
  area.spellcheck = false;
  area.id = fieldId(ctx.idPrefix + path.join("."));
  area.placeholder = '{ "key": "value" }';

  const initial = initialValue(schema, seed);
  if (initial !== undefined && initial !== null && Object.keys(initial as object).length > 0) {
    area.value = JSON.stringify(initial, null, 2);
  }

  wrap.appendChild(label(schema, key, required, area.id));
  wrap.appendChild(
    el(
      "p",
      "hvf-help",
      schema.description
        ? `${schema.description} Enter JSON; it is emitted as YAML.`
        : "This field has no declared shape. Enter JSON; it is emitted as YAML.",
    ),
  );
  wrap.appendChild(area);
  wrap.appendChild(err);
  parent.appendChild(wrap);

  const parsed = (): { ok: true; value: Json } | { ok: false; message: string } => {
    const text = area.value.trim();
    if (text === "") return { ok: true, value: {} };
    try {
      const value = JSON.parse(text) as Json;
      if (!isPlainObject(value)) return { ok: false, message: "Must be a JSON object." };
      return { ok: true, value };
    } catch (e) {
      return { ok: false, message: `Not valid JSON: ${(e as Error).message}` };
    }
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => {
      const r = parsed();
      if (!r.ok) return ABSENT;
      return Object.keys(r.value as object).length === 0 ? ABSENT : r.value;
    },
    validate: () => {
      const r = parsed();
      if (!r.ok) return r.message;
      if (required && Object.keys(r.value as object).length === 0) return "Required.";
      return null;
    },
    setError: (m) => setError(err, area, m),
    focus: () => area.focus(),
  });
}

// --- arrays ----------------------------------------------------------------

function arrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const itemsRaw = asSchema(schema.items);
  const items = itemsRaw ? resolveRef(itemsRaw, ctx.root) : null;
  if (!items) {
    unsupported(parent, key, schema, path, "array without a usable `items` schema");
    return;
  }

  // `uses: [dep, {dep: ENV_VAR}]` -- an entry is either a bare name or a
  // single-key map renaming it. Two inputs per row covers both.
  const alias = aliasUnion(items, ctx.root);
  if (alias) {
    aliasArrayField(parent, key, schema, alias, path, required, ctx, seed);
    return;
  }

  const collapsed = collapseUnion(items, ctx.root);
  if (!collapsed) {
    unsupported(
      parent,
      key,
      schema,
      path,
      "its item schema is a union this form cannot reduce to one control",
    );
    return;
  }
  const itemType = typeOf(collapsed);

  if (itemType === "object") {
    if (isOpenMap(collapsed)) {
      unsupported(parent, key, schema, path, "array items are free-form maps");
      return;
    }
    if (depth >= MAX_DEPTH) {
      unsupported(parent, key, schema, path, `nesting deeper than ${MAX_DEPTH} levels is not rendered`);
      return;
    }
    objectArrayField(parent, key, schema, collapsed, path, required, depth, ctx, seed);
    return;
  }
  if (itemType === "string" || itemType === "number" || itemType === "integer" || itemType === "boolean") {
    scalarArrayField(parent, key, schema, collapsed, path, required, ctx, itemType, seed);
    return;
  }
  unsupported(parent, key, schema, path, "array items are neither scalars nor objects");
}

/** Shared chrome for the repeatable controls: label, help, list, add button, error. */
function listShell(
  parent: HTMLElement,
  schema: JSONSchema,
  key: string,
  required: boolean,
  addLabel: string,
): { list: HTMLElement; err: HTMLElement; add: HTMLButtonElement; empty: HTMLElement } {
  const wrap = el("div", "hvf-f");
  wrap.appendChild(label(schema, key, required, ""));
  if (schema.description) wrap.appendChild(el("p", "hvf-help", schema.description));
  const empty = el("p", "hvf-empty", "None.");
  wrap.appendChild(empty);
  const list = el("div", "hvf-list");
  wrap.appendChild(list);
  const add = el("button", "hvf-b hvf-add", addLabel) as HTMLButtonElement;
  add.type = "button";
  wrap.appendChild(add);
  const err = el("div", "hvf-e");
  wrap.appendChild(err);
  parent.appendChild(wrap);
  return { list, err, add, empty };
}

function removeButton(label: string, onClick: () => void): HTMLButtonElement {
  const rm = el("button", "hvf-b hvf-x", "×") as HTMLButtonElement;
  rm.type = "button";
  rm.title = "Remove";
  rm.setAttribute("aria-label", label);
  rm.addEventListener("click", onClick);
  return rm;
}

function scalarArrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  items: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
  itemType: JsonSchemaType,
  seed: Json | undefined,
): void {
  const { list, err, add, empty } = listShell(parent, schema, key, required, "+ Add");
  const rows: Control[] = [];
  const refresh = () => {
    empty.style.display = rows.length === 0 ? "" : "none";
  };

  const addRow = (value?: Json) => {
    const row = el("div", "hvf-row");
    const control =
      Array.isArray(items.enum) && items.enum.length > 0
        ? enumControl(items, false, value)
        : inputControl({ ...items, default: undefined }, itemType, value);
    row.appendChild(control);
    row.appendChild(
      removeButton("Remove item", () => {
        const i = rows.indexOf(control);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
        refresh();
      }),
    );
    list.appendChild(row);
    rows.push(control);
    refresh();
    return control;
  };

  add.addEventListener("click", () => addRow().focus());
  const initial = initialValue(schema, seed);
  if (Array.isArray(initial)) for (const v of initial) addRow(v);
  refresh();

  const readRows = (): Json[] => {
    const out: Json[] = [];
    for (const c of rows) {
      const v = readScalar(c, itemType);
      // A row the user added but left blank is not a value; it is an unfinished
      // row, and emitting `- ""` into a list would be wrong.
      if (v === ABSENT || v === "") continue;
      out.push(v);
    }
    return out;
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => {
      const vals = readRows();
      return emptyOr(vals, vals.length === 0, schema);
    },
    validate: () => {
      const vals = readRows();
      const count = countError(vals.length, schema, required);
      if (count) return count;
      if (schema.uniqueItems === true) {
        const seen = new Set<string>();
        for (const v of vals) {
          const k = JSON.stringify(v);
          if (seen.has(k)) return `Entries must be unique; ${JSON.stringify(v)} is repeated.`;
          seen.add(k);
        }
      }
      for (const c of rows) {
        const v = readScalar(c, itemType);
        if (v === ABSENT || v === "") continue;
        const msg = validateScalar(v, items, itemType, false);
        if (msg) return msg;
      }
      return null;
    },
    setError: (m) => setError(err, null, m),
    focus: () => (rows[0] ?? add).focus(),
  });
}

/**
 * An empty container reads as ABSENT unless the schema declares a default.
 *
 * At the top level prune.ts would drop an empty `[]`/`{}` anyway, but inside an
 * array or map card it never gets the chance -- prune treats a list as atomic and
 * does not walk into its items. Without this, every untouched repeatable inside a
 * card leaks an empty list into the emitted file. With a default present the
 * empty form is kept, because that is how the user says "clear it".
 */
function emptyOr<T>(value: T, isEmpty: boolean, schema: JSONSchema): T | typeof ABSENT {
  return isEmpty && schema.default === undefined ? ABSENT : value;
}

function countError(n: number, schema: JSONSchema, required: boolean): string | null {
  if (n === 0 && required) return "At least one entry is required.";
  if (typeof schema.minItems === "number" && n < schema.minItems) {
    return `At least ${schema.minItems} entries are required.`;
  }
  if (typeof schema.maxItems === "number" && n > schema.maxItems) {
    return `At most ${schema.maxItems} entries are allowed.`;
  }
  return null;
}

// --- a bare name, or a single-key map renaming it ---------------------------

interface AliasUnion {
  name: JSONSchema;
  nameType: JsonSchemaType;
  alias: JSONSchema;
  aliasType: JsonSchemaType;
  keySchema: JSONSchema | null;
}

function aliasUnion(items: JSONSchema, root: JSONSchema): AliasUnion | null {
  const branches = items.oneOf ?? items.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return null;

  const resolved: JSONSchema[] = [];
  for (const b of branches) {
    const r = resolveRef(b, root);
    if (!r) return null;
    resolved.push(r);
  }

  const scalar = resolved.find((b) => {
    const t = typeOf(b);
    return t !== null && t !== "object" && t !== "array";
  });
  const map = resolved.find((b) => b !== scalar && typeOf(b) === "object" && isOpenMap(b));
  if (!scalar || !map) return null;

  const nameType = typeOf(scalar)!;
  const aliasSchema = asSchema(map.additionalProperties);
  if (!aliasSchema) return null;
  const aliasType = typeOf(aliasSchema);
  if (!aliasType || aliasType === "object" || aliasType === "array") return null;

  return {
    name: scalar,
    nameType,
    alias: aliasSchema,
    aliasType,
    keySchema: map.propertyNames ?? null,
  };
}

function aliasArrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  union: AliasUnion,
  path: string[],
  required: boolean,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const { list, err, add, empty } = listShell(parent, schema, key, required, "+ Add");
  const rows: { name: Control; alias: Control }[] = [];
  const refresh = () => {
    empty.style.display = rows.length === 0 ? "" : "none";
  };

  const addRow = (name?: Json, alias?: Json) => {
    const row = el("div", "hvf-row");
    const nameIn = inputControl({ ...union.name, default: undefined }, union.nameType, name);
    nameIn.placeholder = "name";
    const aliasIn = inputControl({ ...union.alias, default: undefined }, union.aliasType, alias);
    aliasIn.placeholder = "as (optional)";
    const entry = { name: nameIn, alias: aliasIn };
    row.appendChild(nameIn);
    row.appendChild(aliasIn);
    row.appendChild(
      removeButton("Remove item", () => {
        const i = rows.indexOf(entry);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
        refresh();
      }),
    );
    list.appendChild(row);
    rows.push(entry);
    refresh();
    return entry;
  };

  add.addEventListener("click", () => addRow().name.focus());
  const initial = initialValue(schema, seed);
  if (Array.isArray(initial)) {
    for (const v of initial) {
      if (isPlainObject(v)) {
        const k = Object.keys(v)[0];
        if (k !== undefined) addRow(k, v[k]);
      } else if (v !== null) {
        addRow(v);
      }
    }
  }
  refresh();

  const readRows = (): Json[] => {
    const out: Json[] = [];
    for (const r of rows) {
      const name = String(readScalar(r.name, union.nameType) ?? "").trim();
      if (name === "") continue;
      const aliasRaw = readScalar(r.alias, union.aliasType);
      const alias = aliasRaw === ABSENT ? "" : aliasRaw;
      // Blank alias means "no rename", which is the bare-string branch.
      out.push(alias === "" || alias === null ? name : { [name]: alias });
    }
    return out;
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => {
      const vals = readRows();
      return emptyOr(vals, vals.length === 0, schema);
    },
    validate: () => {
      const vals = readRows();
      const count = countError(vals.length, schema, required);
      if (count) return count;
      const seen = new Set<string>();
      for (const r of rows) {
        const name = String(readScalar(r.name, union.nameType) ?? "").trim();
        const aliasRaw = readScalar(r.alias, union.aliasType);
        if (name === "") {
          if (aliasRaw !== ABSENT && aliasRaw !== "") return "A name is required for this entry.";
          continue;
        }
        if (seen.has(name)) return `Duplicate entry: ${name}`;
        seen.add(name);
        const nameMsg =
          union.nameType === "string"
            ? validateString(name, union.name) ?? (union.keySchema ? validateString(name, union.keySchema) : null)
            : validateScalar(readScalar(r.name, union.nameType), union.name, union.nameType, true);
        if (nameMsg) return nameMsg;
        if (aliasRaw !== ABSENT && aliasRaw !== "") {
          const aliasMsg = validateScalar(aliasRaw, union.alias, union.aliasType, false);
          if (aliasMsg) return aliasMsg;
        }
      }
      return null;
    },
    setError: (m) => setError(err, null, m),
    focus: () => (rows[0]?.name ?? add).focus(),
  });
}

// --- repeatable object cards ------------------------------------------------

interface Card {
  el: HTMLElement;
  group: Group;
  /** Present only for map entries, which are keyed by the user. */
  key?: HTMLInputElement;
  keyErr?: HTMLElement;
  result: GroupResult;
}

/**
 * Builds one card: an optional key input, then the item schema's *entire* field
 * set in the card's own group. Because it recurses through renderProperties, an
 * item may itself contain sections, arrays, maps and conditionals.
 */
function buildCard(opts: {
  list: HTMLElement;
  items: JSONSchema;
  depth: number;
  ctx: Ctx;
  seed: Json | undefined;
  keyed: { label: string; value?: string } | null;
  onRemove: (card: Card) => void;
}): Card {
  const { items, ctx } = opts;
  const cardEl = el("div", "hvf-card");
  const head = el("div", "hvf-cardhd");
  head.appendChild(el("span", "hvf-cardlabel"));
  const group: Group = { bindings: [] };
  const card: Card = { el: cardEl, group, result: { count: 0, first: null, open: new Set() } };
  head.appendChild(removeButton("Remove entry", () => opts.onRemove(card)));
  cardEl.appendChild(head);

  if (opts.keyed) {
    const keyWrap = el("div", "hvf-f");
    const keyIn = document.createElement("input");
    keyIn.className = "hvf-in";
    keyIn.type = "text";
    keyIn.placeholder = opts.keyed.label;
    if (opts.keyed.value !== undefined) keyIn.value = opts.keyed.value;
    keyWrap.appendChild(el("label", "hvf-l", opts.keyed.label));
    keyWrap.appendChild(keyIn);
    const keyErr = el("div", "hvf-e");
    keyWrap.appendChild(keyErr);
    cardEl.appendChild(keyWrap);
    card.key = keyIn;
    card.keyErr = keyErr;
  }

  const body = el("div", "hvf-cardbody");
  cardEl.appendChild(body);

  const cardCtx: Ctx = { ...ctx, group, idPrefix: `${ctx.idPrefix}c${++cardSeq}-` };
  const conds = conditionals(items, ctx.root);
  if (conds) conditionalBody(body, items, conds, [], opts.depth + 1, cardCtx, opts.seed);
  else renderProperties(body, items, [], opts.depth + 1, cardCtx, opts.seed);

  opts.list.appendChild(cardEl);
  return card;
}

function objectArrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  items: JSONSchema,
  path: string[],
  required: boolean,
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const { list, err, add, empty } = listShell(parent, schema, key, required, "+ Add");
  const cards: Card[] = [];

  const renumber = () => {
    empty.style.display = cards.length === 0 ? "" : "none";
    cards.forEach((c, i) => {
      const lab = c.el.querySelector(".hvf-cardlabel");
      if (lab) lab.textContent = `${labelOf(items, key)} ${i + 1}`;
    });
  };

  const addCard = (value?: Json) => {
    const card = buildCard({
      list,
      items,
      depth,
      ctx,
      seed: value,
      keyed: null,
      onRemove: (c) => {
        const i = cards.indexOf(c);
        if (i >= 0) cards.splice(i, 1);
        c.el.remove();
        renumber();
      },
    });
    cards.push(card);
    renumber();
    return card;
  };

  add.addEventListener("click", () => {
    const c = addCard();
    c.group.bindings[0]?.focus();
  });
  const initial = initialValue(schema, seed);
  if (Array.isArray(initial)) for (const v of initial) addCard(v);
  renumber();

  const readCards = (): Json[] => {
    const out: Json[] = [];
    for (const c of cards) {
      const obj = readGroup(c.group);
      // An untouched card is an unfinished row, not an empty list entry.
      if (Object.keys(obj).length > 0) out.push(obj);
    }
    return out;
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => {
      const vals = readCards();
      return emptyOr(vals, vals.length === 0, schema);
    },
    validate: () => {
      let total = 0;
      let first: Binding | null = null;
      for (const c of cards) {
        c.result = validateGroup(c.group);
        total += c.result.count;
        if (!first) first = c.result.first;
      }
      if (first) return `${total} field${total === 1 ? "" : "s"} inside need${total === 1 ? "s" : ""} attention.`;
      return countError(readCards().length, schema, required);
    },
    setError: (m) => setError(err, null, m),
    focus: () => {
      for (const c of cards) {
        if (c.result.first) {
          c.result.first.focus();
          return;
        }
      }
      add.focus();
    },
    errorCount: () => cards.reduce((n, c) => n + c.result.count, 0) || 1,
    openSections: () => cards.flatMap((c) => Array.from(c.result.open)),
  });
}

/**
 * A map whose values are objects: `workloads`, `dependencies`. One card per
 * entry, keyed by a name the user types, validated against `propertyNames`.
 */
function mapOfObjectsField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  items: JSONSchema,
  path: string[],
  required: boolean,
  depth: number,
  ctx: Ctx,
  seed: Json | undefined,
): void {
  const { list, err, add, empty } = listShell(parent, schema, key, required, "+ Add");
  const cards: Card[] = [];
  const keySchema = schema.propertyNames ?? null;
  const keyLabel = singular(labelOf(schema, key));

  const renumber = () => {
    empty.style.display = cards.length === 0 ? "" : "none";
    cards.forEach((c) => {
      const lab = c.el.querySelector(".hvf-cardlabel");
      if (lab) lab.textContent = c.key?.value.trim() || keyLabel;
    });
  };

  const addCard = (name?: string, value?: Json) => {
    const card = buildCard({
      list,
      items,
      depth,
      ctx,
      seed: value,
      keyed: { label: `${keyLabel} name`, ...(name !== undefined ? { value: name } : {}) },
      onRemove: (c) => {
        const i = cards.indexOf(c);
        if (i >= 0) cards.splice(i, 1);
        c.el.remove();
        renumber();
      },
    });
    card.key?.addEventListener("input", renumber);
    cards.push(card);
    renumber();
    return card;
  };

  add.addEventListener("click", () => addCard().key?.focus());
  const initial = initialValue(schema, seed);
  if (isPlainObject(initial)) {
    for (const [name, value] of Object.entries(initial)) addCard(name, value);
  }
  renumber();

  const readMap = (): Record<string, Json> => {
    const out: Record<string, Json> = {};
    for (const c of cards) {
      const name = c.key?.value.trim() ?? "";
      if (name === "") continue;
      out[name] = readGroup(c.group);
    }
    return out;
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    read: () => {
      const map = readMap();
      return emptyOr(map, Object.keys(map).length === 0, schema);
    },
    validate: () => {
      const seen = new Set<string>();
      let keyProblem: string | null = null;
      let total = 0;
      let first: Binding | null = null;

      for (const c of cards) {
        const name = c.key?.value.trim() ?? "";
        let msg: string | null = null;
        if (name === "") msg = `A ${keyLabel.toLowerCase()} name is required.`;
        else if (seen.has(name)) msg = `Duplicate name: ${name}`;
        else {
          seen.add(name);
          if (keySchema) msg = validateString(name, keySchema);
        }
        if (c.keyErr) setError(c.keyErr, c.key ?? null, msg);
        if (msg && !keyProblem) keyProblem = msg;

        c.result = validateGroup(c.group);
        total += c.result.count;
        if (!first) first = c.result.first;
      }

      if (keyProblem) return keyProblem;
      if (first) return `${total} field${total === 1 ? "" : "s"} inside need${total === 1 ? "s" : ""} attention.`;
      if (required && seen.size === 0) return "At least one entry is required.";
      if (typeof schema.minProperties === "number" && seen.size < schema.minProperties) {
        return `At least ${schema.minProperties} entries are required.`;
      }
      if (typeof schema.maxProperties === "number" && seen.size > schema.maxProperties) {
        return `At most ${schema.maxProperties} entries are allowed.`;
      }
      return null;
    },
    setError: (m) => setError(err, null, m),
    focus: () => {
      for (const c of cards) {
        if (c.key && c.key.classList.contains("hvf-bad")) {
          c.key.focus();
          return;
        }
        if (c.result.first) {
          c.result.first.focus();
          return;
        }
      }
      (cards[0]?.key ?? add).focus();
    },
    errorCount: () => cards.reduce((n, c) => n + c.result.count, 0) || 1,
    openSections: () => cards.flatMap((c) => Array.from(c.result.open)),
  });
}

function singular(label: string): string {
  return label.endsWith("ies")
    ? `${label.slice(0, -3)}y`
    : label.endsWith("s")
      ? label.slice(0, -1)
      : label;
}

// --- free-form maps (podAnnotations, nodeSelector, env) --------------------

interface KvOptions {
  label?: string;
  /**
   * Property names that already have their own control at this same path. Passing
   * this makes the binding a merge (see Binding.merge) and makes those keys an
   * error rather than a silent shadow of a schema-validated field.
   */
  reserved?: string[];
}

function kvField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
  seed: Json | undefined,
  options: KvOptions = {},
): void {
  const reserved = new Set(options.reserved ?? []);
  const keySchema = schema.propertyNames ?? null;
  const ap = asSchema(schema.additionalProperties) ?? {};
  const resolvedValue = resolveRef(ap, ctx.root);
  const valueSchema = resolvedValue ? collapseUnion(resolvedValue, ctx.root) : null;
  const vType = valueSchema ? (typeOf(valueSchema) ?? "string") : "string";
  if (vType === "object" || vType === "array") {
    unsupported(parent, key, schema, path, "map values are not scalars");
    return;
  }

  const shellSchema = options.label ? { ...schema, title: options.label } : schema;
  const { list, err, add, empty } = listShell(parent, shellSchema, key, required, "+ Add key");
  const rows: { key: HTMLInputElement; value: Control; err: HTMLElement }[] = [];
  const refresh = () => {
    empty.style.display = rows.length === 0 ? "" : "none";
  };

  const addRow = (k?: string, v?: Json) => {
    const row = el("div", "hvf-row");
    const kIn = document.createElement("input");
    kIn.className = "hvf-in";
    kIn.type = "text";
    kIn.placeholder = "key";
    if (k !== undefined) kIn.value = k;
    const vIn =
      valueSchema && Array.isArray(valueSchema.enum) && valueSchema.enum.length > 0
        ? enumControl(valueSchema, false, v)
        : inputControl({ ...(valueSchema ?? {}), default: undefined }, vType, v);
    if (vIn instanceof HTMLInputElement) vIn.placeholder = "value";
    const entry = { key: kIn, value: vIn, err: el("div", "hvf-e") };
    row.appendChild(kIn);
    row.appendChild(vIn);
    row.appendChild(
      removeButton("Remove key", () => {
        const i = rows.indexOf(entry);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
        refresh();
      }),
    );
    list.appendChild(row);
    list.appendChild(entry.err);
    rows.push(entry);
    refresh();
    return entry;
  };

  add.addEventListener("click", () => addRow().key.focus());
  const initial = initialValue(schema, seed);
  if (isPlainObject(initial)) {
    for (const [k, v] of Object.entries(initial)) addRow(k, v);
  }
  refresh();

  const readMap = (): Record<string, Json> => {
    const out: Record<string, Json> = {};
    for (const r of rows) {
      const k = r.key.value.trim();
      if (k === "") continue;
      const v = readScalar(r.value, vType);
      out[k] = v === ABSENT ? "" : v;
    }
    return out;
  };

  ctx.group.bindings.push({
    path,
    sections: ctx.sections,
    merge: reserved.size > 0,
    read: () => {
      const map = readMap();
      return emptyOr(map, Object.keys(map).length === 0, schema);
    },
    validate: () => {
      const seen = new Set<string>();
      let first: string | null = null;
      for (const r of rows) {
        const k = r.key.value.trim();
        const v = readScalar(r.value, vType);
        let msg: string | null = null;
        if (k === "" && v !== ABSENT && v !== "") msg = "A key is required for this value.";
        else if (k !== "" && seen.has(k)) msg = `Duplicate key: ${k}`;
        else if (reserved.has(k)) msg = `${k} has its own field above; use that instead.`;
        else if (k !== "") {
          seen.add(k);
          msg = keySchema ? validateString(k, keySchema) : null;
          if (!msg && valueSchema) msg = validateScalar(v, valueSchema, vType, false);
        }
        setError(r.err, k === "" ? r.key : r.value, msg);
        if (msg && !first) first = msg;
      }
      if (first) return first;
      if (required && seen.size === 0) return "At least one key is required.";
      if (typeof schema.minProperties === "number" && seen.size < schema.minProperties) {
        return `At least ${schema.minProperties} keys are required.`;
      }
      if (typeof schema.maxProperties === "number" && seen.size > schema.maxProperties) {
        return `At most ${schema.maxProperties} keys are allowed.`;
      }
      return null;
    },
    setError: (m) => setError(err, null, m),
    focus: () => (rows[0]?.key ?? add).focus(),
  });
}

// --- fallbacks and small DOM helpers --------------------------------------

/**
 * The never-throw path. Every branch above that cannot render a node honestly
 * lands here, so a schema we only partly understand still produces a usable
 * form with a visible hole rather than an empty iframe.
 */
function unsupported(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  reason: string,
): void {
  const wrap = el("div", "hvf-f");
  wrap.appendChild(label(schema, key, false, ""));
  const input = document.createElement("input");
  input.className = "hvf-in";
  input.type = "text";
  input.value = "Unsupported field type";
  input.disabled = true;
  wrap.appendChild(input);
  wrap.appendChild(el("p", "hvf-help", `${path.join(".") || key}: ${reason}.`));
  parent.appendChild(wrap);
}

function banner(title: string, detail: string, paths?: string[]): HTMLElement {
  const box = el("div", "hvf-banner");
  box.setAttribute("role", "alert");
  box.appendChild(el("b", "", title));
  box.appendChild(document.createTextNode(detail));
  if (paths && paths.length > 0) {
    const ul = document.createElement("ul");
    for (const p of paths) {
      const li = document.createElement("li");
      li.appendChild(el("span", "hvf-mono", p));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

function label(schema: JSONSchema, key: string, required: boolean, forId: string): HTMLElement {
  const lab = el("label", "hvf-l", labelOf(schema, key));
  if (forId) lab.setAttribute("for", forId);
  if (required) {
    const star = el("span", "hvf-req", "*");
    star.setAttribute("aria-hidden", "true");
    lab.appendChild(star);
  }
  return lab;
}

function labelOf(schema: JSONSchema, key: string): string {
  return schema.title && schema.title !== "" ? schema.title : key;
}

function setError(
  errEl: HTMLElement,
  control: Control | HTMLTextAreaElement | null,
  msg: string | null,
): void {
  errEl.textContent = msg ?? "";
  errEl.classList.toggle("hvf-on", msg !== null);
  if (control) {
    control.classList.toggle("hvf-bad", msg !== null);
    // aria-invalid rather than the HTML5 constraint API: we own the messaging,
    // and native validation UI is unavailable without a <form> anyway.
    if (msg) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Distinguishes cards so their group-relative field ids stay unique. */
let cardSeq = 0;

function fieldId(name: string): string {
  return `hvf-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function setPath(target: Record<string, Json>, path: string[], value: Json): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = node[seg];
    if (!isPlainObject(next)) {
      const fresh: Record<string, Json> = {};
      node[seg] = fresh;
      node = fresh;
    } else {
      node = next;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) node[last] = value;
  else if (isPlainObject(value)) Object.assign(target, value);
}

/**
 * Adds the map's keys at `path` without disturbing what is already there. Used
 * only by the extra-keys editor, whose path is a node that its sibling controls
 * have already populated -- assigning would throw their values away.
 */
function mergePath(target: Record<string, Json>, path: string[], value: Record<string, Json>): void {
  let node = target;
  for (const seg of path) {
    const next = node[seg];
    if (!isPlainObject(next)) {
      const fresh: Record<string, Json> = {};
      node[seg] = fresh;
      node = fresh;
    } else {
      node = next;
    }
  }
  for (const [k, v] of Object.entries(value)) {
    // A collision is already a validation error, so this cannot silently shadow
    // a typed control; the guard is belt-and-braces.
    if (!Object.prototype.hasOwnProperty.call(node, k)) node[k] = v;
  }
}
