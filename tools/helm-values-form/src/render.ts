/**
 * JSON Schema -> DOM, validation, and submit.
 *
 * Three rules shape every line of this file:
 *
 *  1. No `innerHTML`, ever. Titles, descriptions and enum values come from
 *     upstream chart schemas nobody here controls, so everything
 *     schema-derived goes in through `textContent`.
 *  2. No `<form>` and no `type="submit"`. Form submission inside an Open WebUI
 *     embed is gated behind a per-user setting that defaults to off, so a real
 *     submit silently does nothing for most users. It is a plain button with a
 *     click handler.
 *  3. A bad schema must never blank the iframe. Any node we cannot render
 *     honestly becomes a disabled "Unsupported field type" control, and a
 *     malformed root becomes an error banner -- never a thrown exception and an
 *     empty box.
 */

import { valuesYaml } from "./values.js";
import { collapseUnion, isNullable, isOpenMap, resolvePath, resolveRef, typeOf } from "./prune.js";
import { CSS } from "./theme.js";
import type { FormConfig, Json, JSONSchema, JsonSchemaType, SubmitHandler } from "./types.js";

/** How deep object nesting is rendered before falling back to unsupported. */
const MAX_DEPTH = 4;

/**
 * "The user entered nothing here." Distinct from the empty string and from an
 * explicit null, both of which are real values a user can mean. Absent paths
 * never reach the values object at all, which keeps a blank number input from
 * arriving at the YAML emitter as `""`.
 */
const ABSENT = Symbol("absent");
type Reading = Json | typeof ABSENT;

interface Binding {
  path: string[];
  read(): Reading;
  /** Error message, or null when valid. */
  validate(): string | null;
  setError(msg: string | null): void;
  focus(): void;
  /** Every `<details>` above this control, so an error can un-collapse them. */
  sections: HTMLDetailsElement[];
  /**
   * Set for the extra-keys editor on a node that has fixed `properties` *and*
   * `additionalProperties`. Such a binding reads a map of user-chosen keys that
   * belong at the node's own path, alongside the values its sibling controls
   * collected -- so it has to be merged in, not assigned over the top.
   */
  merge?: boolean;
}

interface Ctx {
  root: JSONSchema;
  bindings: Binding[];
  sections: HTMLDetailsElement[];
}

export function render(root: HTMLElement, cfg: FormConfig, onSubmit: SubmitHandler): void {
  root.textContent = "";
  root.className = "hvf";

  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  const head = el("h1", "hvf-h", cfg.title || cfg.chart);
  root.appendChild(head);
  if (cfg.description) root.appendChild(el("p", "hvf-sub", cfg.description));

  const schema = resolveRef(cfg.schema, cfg.schema);

  // A stale allowlist is the failure this check exists for: a chart bump moves
  // or renames a field, the path stops resolving, and a form that silently
  // dropped it would produce a values file missing an override the user asked
  // for. Loud and non-submittable is the only safe outcome.
  const missing = (cfg.include ?? []).filter(
    (p) => !schema || resolvePath(schema, p) === null,
  );
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

  const ctx: Ctx = { root: schema, bindings: [], sections: [] };
  const body = el("div", "hvf-body");
  root.appendChild(body);
  renderProperties(body, schema, [], 0, ctx);

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
    let first: Binding | null = null;
    let bad = 0;
    // Expand the sections of *every* invalid field, not just the first one.
    // Expanding only the first hides the rest whenever the first happens to sit
    // at the top level: its section chain is empty, nothing opens, and the user
    // is told three fields need attention while looking at three collapsed
    // sections.
    const toOpen = new Set<HTMLDetailsElement>();
    for (const b of ctx.bindings) {
      const err = b.validate();
      b.setError(err);
      if (err !== null) {
        bad++;
        if (!first) first = b;
        for (const d of b.sections) toOpen.add(d);
      }
    }
    if (first) {
      summary.textContent = `${bad} field${bad === 1 ? "" : "s"} need${bad === 1 ? "s" : ""} attention.`;
      for (const d of toOpen) d.open = true;
      first.focus();
      return;
    }
    summary.textContent = "";

    // Same call scripts/helm-check.mjs makes, so what CI feeds to Helm is what
    // this button produces.
    const { yaml, overrides } = valuesYaml(collect(ctx.bindings), cfg.schema, {
      chart: cfg.chart,
      ...(cfg.chartVersion ? { chartVersion: cfg.chartVersion } : {}),
    });
    onSubmit(yaml, overrides);
  });
}

function hasRenderableProps(schema: JSONSchema): boolean {
  return Object.keys(schema.properties ?? {}).length > 0 || isOpenMap(schema);
}

// --- tree walking ----------------------------------------------------------

function renderProperties(
  parent: HTMLElement,
  schema: JSONSchema,
  path: string[],
  depth: number,
  ctx: Ctx,
): void {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const key of Object.keys(props)) {
    renderNode(parent, key, props[key]!, [...path, key], required.has(key), depth, ctx);
  }

  // A node with both fixed properties and an open key space: render the fixed
  // ones above, then one editor for the rest. `reserved` both marks this binding
  // as a merge (its path is the node's own) and lets it reject a key that
  // already has a dedicated control.
  if (isOpenMap({ ...schema, properties: undefined }) && Object.keys(props).length > 0) {
    kvField(parent, "additionalProperties", schema, path, false, ctx, {
      label: "Additional keys",
      reserved: Object.keys(props),
    });
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
): void {
  const resolved = resolveRef(raw, ctx.root);
  if (!resolved) {
    // Remote $ref, or a cycle. We do not fetch: see prune.ts/resolveRef.
    unsupported(parent, key, raw, path, "this field's $ref could not be resolved locally");
    return;
  }
  const schema = collapseUnion(resolved, ctx.root);
  if (!schema) {
    unsupported(parent, key, resolved, path, "anyOf/oneOf branches are not all scalars");
    return;
  }

  const type = typeOf(schema);

  if (type === "object") {
    if (isOpenMap(schema)) {
      kvField(parent, key, schema, path, required, ctx);
      return;
    }
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      unsupported(parent, key, schema, path, "object with no properties and no additionalProperties");
      return;
    }
    if (depth >= MAX_DEPTH) {
      unsupported(parent, key, schema, path, `nesting deeper than ${MAX_DEPTH} levels is not rendered`);
      return;
    }
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

    const nested: Ctx = { ...ctx, sections: [...ctx.sections, details] };
    renderProperties(inner, schema, path, depth + 1, nested);
    return;
  }

  if (type === "array") {
    arrayField(parent, key, schema, path, required, ctx);
    return;
  }

  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    scalarField(parent, key, schema, path, required, ctx, type);
    return;
  }

  unsupported(parent, key, schema, path, `unrecognized type: ${JSON.stringify(schema.type ?? null)}`);
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
): void {
  const wrap = el("div", "hvf-f");
  const err = el("div", "hvf-e");
  const dotted = path.join(".");

  if (type === "boolean") {
    const row = el("div", "hvf-cbrow");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = fieldId(dotted);
    box.checked = schema.default === true;
    const isSet = touchTracker(box, schema);
    const lab = label(schema, key, required, box.id);
    row.appendChild(box);
    row.appendChild(lab);
    wrap.appendChild(row);
    if (schema.description) wrap.appendChild(el("p", "hvf-help", schema.description));
    wrap.appendChild(err);
    parent.appendChild(wrap);

    ctx.bindings.push({
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
      ? enumControl(schema, required)
      : inputControl(schema, type);
  control.id = fieldId(dotted);

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
    nullBox.checked = schema.default === null;
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

  const read = (): Reading => {
    if (nullBox?.checked) return null;
    return readScalar(control, type);
  };

  ctx.bindings.push({
    path,
    sections: ctx.sections,
    read,
    validate: () => {
      if (nullBox?.checked) return null;
      return validateScalar(readScalar(control, type), schema, type, required);
    },
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

function enumControl(schema: JSONSchema, required: boolean): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "hvf-sel";
  const values = schema.enum ?? [];
  const hasDefault = schema.default !== undefined;
  // An empty option is what lets "nothing chosen" exist; without it a required
  // select would be silently pre-answered with whatever came first.
  if (!hasDefault || !required) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "—";
    sel.appendChild(blank);
  }
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v);
    sel.appendChild(opt);
  }
  if (hasDefault) sel.value = String(schema.default);
  else sel.value = "";
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

function inputControl(schema: JSONSchema, type: JsonSchemaType): HTMLInputElement {
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
  if (schema.default !== undefined && schema.default !== null) {
    input.value = String(schema.default);
  }
  if (typeof schema.default === "string" && schema.default === "") input.value = "";
  input.placeholder = schema.default === undefined ? "" : String(schema.default ?? "");
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

  const s = String(value);
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

// --- arrays ----------------------------------------------------------------

function arrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
): void {
  const itemsRaw = schema.items;
  const items = itemsRaw ? resolveRef(itemsRaw, ctx.root) : null;
  const collapsed = items ? collapseUnion(items, ctx.root) : null;
  if (!collapsed) {
    unsupported(parent, key, schema, path, "array without a usable `items` schema");
    return;
  }
  const itemType = typeOf(collapsed);

  if (itemType === "object") {
    objectArrayField(parent, key, schema, collapsed, path, required, ctx);
    return;
  }
  if (itemType === "string" || itemType === "number" || itemType === "integer" || itemType === "boolean") {
    scalarArrayField(parent, key, schema, collapsed, path, required, ctx, itemType);
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

function scalarArrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  items: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
  itemType: JsonSchemaType,
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
        ? enumControl(items, false)
        : inputControl({ ...items, default: undefined }, itemType);
    if (value !== undefined && value !== null) control.value = String(value);
    const rm = el("button", "hvf-b hvf-x", "×") as HTMLButtonElement;
    rm.type = "button";
    rm.title = "Remove";
    rm.setAttribute("aria-label", "Remove item");
    rm.addEventListener("click", () => {
      const i = rows.indexOf(control);
      if (i >= 0) rows.splice(i, 1);
      row.remove();
      refresh();
    });
    row.appendChild(control);
    row.appendChild(rm);
    list.appendChild(row);
    rows.push(control);
    refresh();
    return control;
  };

  add.addEventListener("click", () => addRow().focus());
  const def = schema.default;
  if (Array.isArray(def)) for (const v of def) addRow(v);
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

  ctx.bindings.push({
    path,
    sections: ctx.sections,
    read: readRows,
    validate: () => {
      const vals = readRows();
      if (vals.length === 0 && required) return "At least one entry is required.";
      if (typeof schema.minItems === "number" && vals.length < schema.minItems) {
        return `At least ${schema.minItems} entries are required.`;
      }
      if (typeof schema.maxItems === "number" && vals.length > schema.maxItems) {
        return `At most ${schema.maxItems} entries are allowed.`;
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

interface CardField {
  key: string;
  read(): Reading;
  validate(): string | null;
  setError(m: string | null): void;
  focus(): void;
}

function objectArrayField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  items: JSONSchema,
  path: string[],
  required: boolean,
  ctx: Ctx,
): void {
  const props = items.properties ?? {};
  if (Object.keys(props).length === 0) {
    unsupported(parent, key, schema, path, "array of objects with no item properties");
    return;
  }

  const { list, err, add, empty } = listShell(parent, schema, key, required, "+ Add");
  const cards: { el: HTMLElement; fields: CardField[] }[] = [];
  const itemRequired = new Set(items.required ?? []);

  const renumber = () => {
    empty.style.display = cards.length === 0 ? "" : "none";
    cards.forEach((c, i) => {
      const hd = c.el.querySelector(".hvf-cardlabel");
      if (hd) hd.textContent = `${labelOf(items, key)} ${i + 1}`;
    });
  };

  const addCard = (value?: Json) => {
    const card = el("div", "hvf-card");
    const hd = el("div", "hvf-cardhd");
    hd.appendChild(el("span", "hvf-cardlabel"));
    const rm = el("button", "hvf-b hvf-x", "×") as HTMLButtonElement;
    rm.type = "button";
    rm.title = "Remove";
    rm.setAttribute("aria-label", "Remove entry");
    hd.appendChild(rm);
    card.appendChild(hd);

    const fields: CardField[] = [];
    const entry = { el: card, fields };
    rm.addEventListener("click", () => {
      const i = cards.indexOf(entry);
      if (i >= 0) cards.splice(i, 1);
      card.remove();
      renumber();
    });

    const seed = value && typeof value === "object" && !Array.isArray(value) ? value : {};

    for (const sub of Object.keys(props)) {
      const subRaw = props[sub]!;
      const resolved = resolveRef(subRaw, ctx.root);
      const subSchema = resolved ? collapseUnion(resolved, ctx.root) : null;
      const subType = subSchema ? typeOf(subSchema) : null;
      // "One level deep only": a nested object or array inside an array item
      // would need its own repeatable machinery, and no chart needs it badly
      // enough to justify the ambiguity.
      if (!subSchema || subType === "object" || subType === "array" || subType === null) {
        unsupported(card, sub, subSchema ?? subRaw, [...path, sub], "nested inside an array item");
        continue;
      }
      fields.push(cardField(card, sub, subSchema, subType, itemRequired.has(sub), seed[sub]));
    }

    list.appendChild(card);
    cards.push(entry);
    renumber();
    return entry;
  };

  add.addEventListener("click", () => {
    const c = addCard();
    c.fields[0]?.focus();
  });
  const def = schema.default;
  if (Array.isArray(def)) for (const v of def) addCard(v);
  renumber();

  const readCards = (): Json[] => {
    const out: Json[] = [];
    for (const c of cards) {
      const obj: Record<string, Json> = {};
      for (const f of c.fields) {
        const v = f.read();
        if (v === ABSENT || v === "") continue;
        obj[f.key] = v;
      }
      // An untouched card is an unfinished row, not an empty list entry.
      if (Object.keys(obj).length > 0) out.push(obj);
    }
    return out;
  };

  ctx.bindings.push({
    path,
    sections: ctx.sections,
    read: readCards,
    validate: () => {
      let first: string | null = null;
      for (const c of cards) {
        for (const f of c.fields) {
          const msg = f.validate();
          f.setError(msg);
          if (msg && !first) first = msg;
        }
      }
      if (first) return first;
      const vals = readCards();
      if (vals.length === 0 && required) return "At least one entry is required.";
      if (typeof schema.minItems === "number" && vals.length < schema.minItems) {
        return `At least ${schema.minItems} entries are required.`;
      }
      if (typeof schema.maxItems === "number" && vals.length > schema.maxItems) {
        return `At most ${schema.maxItems} entries are allowed.`;
      }
      return null;
    },
    setError: (m) => setError(err, null, m),
    focus: () => {
      for (const c of cards) {
        for (const f of c.fields) {
          if (f.validate()) {
            f.focus();
            return;
          }
        }
      }
      (cards[0]?.fields[0] ?? { focus: () => add.focus() }).focus();
    },
  });
}

function cardField(
  parent: HTMLElement,
  key: string,
  schema: JSONSchema,
  type: JsonSchemaType,
  required: boolean,
  seed: Json | undefined,
): CardField {
  const wrap = el("div", "hvf-f");
  const err = el("div", "hvf-e");

  if (type === "boolean") {
    const row = el("div", "hvf-cbrow");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = fieldId(`${key}-${uid()}`);
    box.checked = typeof seed === "boolean" ? seed : schema.default === true;
    // Seeded from an existing entry, the state is already meaningful; otherwise
    // the same untouched-checkbox problem applies as at the top level.
    const isSet = typeof seed === "boolean" ? () => true : touchTracker(box, schema);
    row.appendChild(box);
    row.appendChild(label(schema, key, required, box.id));
    wrap.appendChild(row);
    wrap.appendChild(err);
    parent.appendChild(wrap);
    return {
      key,
      read: () => (isSet() ? box.checked : ABSENT),
      validate: () => null,
      setError: (m) => setError(err, box, m),
      focus: () => box.focus(),
    };
  }

  const control =
    Array.isArray(schema.enum) && schema.enum.length > 0
      ? enumControl(schema, required)
      : inputControl(schema, type);
  control.id = fieldId(`${key}-${uid()}`);
  if (seed !== undefined && seed !== null) control.value = String(seed);
  wrap.appendChild(label(schema, key, required, control.id));
  wrap.appendChild(control);
  wrap.appendChild(err);
  parent.appendChild(wrap);

  return {
    key,
    read: () => readScalar(control, type),
    validate: () => validateScalar(readScalar(control, type), schema, type, required),
    setError: (m) => setError(err, control, m),
    focus: () => control.focus(),
  };
}

// --- free-form maps (podAnnotations, nodeSelector, extraEnv) ---------------

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
  options: KvOptions = {},
): void {
  const labelOverride = options.label;
  const reserved = new Set(options.reserved ?? []);
  const ap = schema.additionalProperties;
  const valueSchemaRaw = typeof ap === "object" && ap !== null ? ap : {};
  const resolvedValue = resolveRef(valueSchemaRaw as JSONSchema, ctx.root);
  const valueSchema = resolvedValue ? collapseUnion(resolvedValue, ctx.root) : null;
  const vType = valueSchema ? (typeOf(valueSchema) ?? "string") : "string";
  // Only scalar values: a map of objects is a different control, and charts
  // that need one (extraEnv as a list) model it as an array instead.
  if (vType === "object" || vType === "array") {
    unsupported(parent, key, schema, path, "map values are not scalars");
    return;
  }

  const shellSchema = labelOverride ? { ...schema, title: labelOverride } : schema;
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
        ? enumControl(valueSchema, false)
        : inputControl({ ...(valueSchema ?? {}), default: undefined }, vType);
    if (vIn instanceof HTMLInputElement) vIn.placeholder = "value";
    if (v !== undefined && v !== null) vIn.value = String(v);
    const rm = el("button", "hvf-b hvf-x", "×") as HTMLButtonElement;
    rm.type = "button";
    rm.title = "Remove";
    rm.setAttribute("aria-label", "Remove key");
    const entry = { key: kIn, value: vIn, err: el("div", "hvf-e") };
    rm.addEventListener("click", () => {
      const i = rows.indexOf(entry);
      if (i >= 0) rows.splice(i, 1);
      row.remove();
      refresh();
    });
    row.appendChild(kIn);
    row.appendChild(vIn);
    row.appendChild(rm);
    list.appendChild(row);
    rows.push(entry);
    refresh();
    return entry;
  };

  add.addEventListener("click", () => addRow().key.focus());
  const def = schema.default;
  if (def && typeof def === "object" && !Array.isArray(def)) {
    for (const k of Object.keys(def)) addRow(k, def[k]);
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

  ctx.bindings.push({
    path,
    sections: ctx.sections,
    merge: reserved.size > 0,
    read: readMap,
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
          msg = valueSchema ? validateScalar(v, valueSchema, vType, false) : null;
        }
        setError(r.err, k === "" ? r.key : r.value, msg);
        if (msg && !first) first = msg;
      }
      if (first) return first;
      if (required && seen.size === 0) return "At least one key is required.";
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
    lab.appendChild(el("span", "hvf-sr", ""));
  }
  return lab;
}

function labelOf(schema: JSONSchema, key: string): string {
  return schema.title && schema.title !== "" ? schema.title : key;
}

function setError(errEl: HTMLElement, control: Control | null, msg: string | null): void {
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

let counter = 0;
function uid(): string {
  return String(++counter);
}

function fieldId(name: string): string {
  return `hvf-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Walks the bindings into a nested object, skipping everything absent. */
function collect(bindings: Binding[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const b of bindings) {
    const v = b.read();
    if (v === ABSENT) continue;
    if (b.merge && typeof v === "object" && v !== null && !Array.isArray(v)) {
      mergePath(out, b.path, v);
    } else {
      setPath(out, b.path, v);
    }
  }
  return out;
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
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const fresh: Record<string, Json> = {};
      node[seg] = fresh;
      node = fresh;
    } else {
      node = next as Record<string, Json>;
    }
  }
  for (const [k, v] of Object.entries(value)) {
    // A collision is already a validation error, so this cannot silently shadow
    // a typed control; the guard is belt-and-braces.
    if (!Object.prototype.hasOwnProperty.call(node, k)) node[k] = v;
  }
}

function setPath(target: Record<string, Json>, path: string[], value: Json): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = node[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const fresh: Record<string, Json> = {};
      node[seg] = fresh;
      node = fresh;
    } else {
      node = next as Record<string, Json>;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) node[last] = value;
}
