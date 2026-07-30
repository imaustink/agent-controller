# helm-values-form

An Open WebUI **Tool** that renders a Helm chart's `values.schema.json` as a form
inside the chat, then emits a minimal `values.yaml` containing only the fields
that differ from the chart defaults.

The user gets a real form instead of a twenty-turn interview. The chat gets a
values file that states the delta rather than restating the chart.

## How it works

`show_values_form` returns an `HTMLResponse` carrying the header
`Content-Disposition: inline`. Open WebUI's middleware detects that, extracts the
HTML, and renders it in a **sandboxed iframe** inside the assistant message. The
iframe posts the generated YAML back to the parent's chat input with
`postMessage`, so it arrives as the user's next message.

```
model ──> show_values_form("temporal-worker")
             │
             ├─ HTMLResponse(html, {"Content-Disposition": "inline"})   ──> iframe
             └─ context dict                                           ──> the model
                  "a form is displayed; do not ask for these values"

user fills in the form, clicks Generate
             │
             └─ postMessage({type: "input:prompt:submit", text: "```yaml …"})
                  ──> arrives as the user's next chat message

model ──> record_values("temporal-worker", "image.tag, …")
             └─ emits an `embeds` event with replace: true  ──> live form becomes a receipt
```

Everything the iframe needs is inlined into that HTML. It cannot fetch anything:
a sandboxed frame without same-origin access has an opaque origin, so module
imports would go out with `Origin: null`. The cost of inlining is that the bundle
**and the pruned schema are persisted into the chat database on every message**,
which is why there are two byte budgets and why the allowlist matters.

## Layout

```
src/            the renderer, bundled to a single IIFE
  render.ts       JSON Schema -> DOM, validation, submit
  yaml.ts         minimal YAML emitter, no dependencies
  prune.ts        drops values equal to schema defaults; also the shared
                  schema helpers ($ref resolution, dotted-path lookup)
  values.ts       the DOM-free prune+emit path, shared with the helm check
  theme.ts        the stylesheet, as a string
  types.ts        the JSON Schema subset and FormConfig
  index.ts        bundle entry; exposes exactly one global, OWUIForm
shell/
  form_shell.html the embed page, with two substitution markers
charts/
  <name>.form.json    field allowlist + metadata
  <name>.schema.json  a copy of the chart's values.schema.json
  temporal-worker/    fixture chart, rendered by the end-to-end check
tool/
  helm_values_form.py the Open WebUI Tool: one file, pasteable
tests/
  golden/         committed `helm template` output
scripts/
  helm-check.mjs  the end-to-end check
  sync-shell.mjs  copies the shell into the Python tool
```

## Build

```sh
npm install          # from the repo root; this is an npm workspace
npm run build        # -> dist/owui-form.js  (and dist/node/values.mjs)
npm test             # build + unit tests + python tests + the helm check
```

`npm run build` **fails** if the bundle exceeds 32 KB. That is not a style
preference: the bundle is stored in the chat database once per message carrying a
form.

## Install into Open WebUI

1. Copy the built bundle and the chart sidecars somewhere the Open WebUI backend
   can read. Anywhere under its data directory persists across restarts:

   ```sh
   TARGET=/app/backend/data/helm-values-form      # inside the Open WebUI container
   mkdir -p "$TARGET/charts"
   cp dist/owui-form.js "$TARGET/owui-form.js"
   cp charts/*.form.json charts/*.schema.json "$TARGET/charts/"
   ```

2. In Open WebUI, go to **Workspace -> Tools -> +**, paste the whole of
   `tool/helm_values_form.py`, and save. It is self-contained; it carries its own
   copy of the HTML shell.

3. Open the tool's **Valves** and confirm the paths:

   | Valve | Default | Notes |
   |---|---|---|
   | `bundle_path` | `/app/backend/data/helm-values-form/owui-form.js` | the built bundle |
   | `charts_dir` | `/app/backend/data/helm-values-form/charts` | `.form.json` + `.schema.json` files |
   | `max_bundle_bytes` | `32768` | refuse to render above this |
   | `max_config_bytes` | `65536` | refuse to render above this; tighten the allowlist instead of raising it |

4. Enable the tool for a model that uses **Native (Agentic)** tool calling.
   Legacy mode is deprecated and unsupported here.

After a rebuild, re-copy `dist/owui-form.js`. The Python tool reads it from disk
on every call, so no re-paste is needed unless the tool file itself changed.

## Adding a chart

1. Copy the chart's schema in beside the others:

   ```sh
   cp path/to/mychart/values.schema.json charts/mychart.schema.json
   ```

2. Write `charts/mychart.form.json`:

   ```json
   {
     "chart": "mychart",
     "title": "My Chart",
     "description": "Only the fields worth changing per-deployment.",
     "schema": "mychart.schema.json",
     "include": [
       "image.tag",
       "replicaCount",
       "resources.limits.memory",
       "podAnnotations"
     ]
   }
   ```

3. Verify it, ideally against the real chart:

   ```sh
   npm run helm-check                      # the committed temporal-worker fixture
   helm lint path/to/mychart -f out.yaml   # for your own chart
   ```

### About `include`

`include` is a list of dotted paths, and it is the difference between a usable
form and an unusable one — a full Bitnami schema exposes several hundred fields.
Prune to what someone actually changes per deployment.

An empty or absent `include` renders the whole schema. It is supported, and you
should not use it outside of trying a schema out: the entire schema is what gets
serialized into every message.

A path that **does not resolve is a hard error**, surfaced in the form and
refused by the tool, not skipped. That is deliberate. After a chart bump, a
renamed field would otherwise silently vanish from the form and the user would
get a values file missing an override they asked for.

Paths address schema *properties*. `podAnnotations` is a valid path;
`podAnnotations.foo` is not, because those keys belong to the user, not the
schema.

### Charts with no `values.schema.json`

Many charts ship none at all. Two options:

- **Author one.** It is the better outcome, and worth upstreaming — schema
  validation helps everyone using the chart, not just this form.
- **Generate a starting point from `values.yaml` and hand-correct the types.** Be
  aware of what a generator gets wrong: it types every field as whatever its
  example value happens to be. `secretName: null` becomes `type: null` instead of
  `["string", "null"]`; `pullPolicy: IfNotPresent` becomes a bare string instead
  of an `enum`; an empty `extraEnv: []` gives no `items` schema to build rows
  from. Every one of those produces a wrong control or an unsupported fallback.

Also fill in `default` for every field you allowlist. Pruning is defined by
comparison against the schema default, so a field with no default cannot be
recognized as unchanged, and its value ends up in the output even when the user
never touched it. (The renderer covers the one case where that would be most
annoying — an untouched checkbox with no default is not reported as `false` —
but a default in the schema is the real fix.)

## What the schema subset covers

| Schema | Control |
|---|---|
| `object` with `properties` | collapsible section, nested up to 4 deep |
| `string` | text input |
| `string` + `enum` | select |
| `string` + `format: date \| date-time \| email \| uri` | typed input |
| `number` / `integer` | number input (`step=1` for integer) |
| `boolean` | checkbox |
| `array` of scalars | repeatable rows, add/remove |
| `array` of objects | repeatable card of sub-fields, one level deep |
| `additionalProperties` | key/value editor — `podAnnotations`, `nodeSelector` |
| `type: ["string", "null"]` | the control plus an explicit "set to null" toggle |
| local `$ref` into `$defs` / `definitions` | resolved before rendering |
| `anyOf` / `oneOf`, all-scalar branches | rendered as the first branch |

Honored: `title`, `description`, `default`, `required` at every level, `enum`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
`minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`.

Anything else renders as a disabled **Unsupported field type** control naming the
path and the reason. A malformed schema renders an error banner. Neither throws,
and neither produces a blank iframe.

Remote `$ref`s are **not** fetched — see the sandboxing note above — and fall
back to unsupported.

Note that `definitions` is draft-07's own keyword and `$defs` arrived in 2019-09.
The renderer accepts both, but if the chart's schema declares
`$schema: draft-07`, prefer `definitions`: some Helm versions validate against a
strict draft-07 implementation.

## Validation

Client-side, on submit. Native HTML5 validation UI is unavailable here — it
depends on form semantics this embed cannot use — so the renderer does it itself:
it blocks submission, writes per-field error text, expands every section holding
an error, and focuses the first invalid control.

## What the output looks like

Overriding just the image tag and the memory limit on the fixture chart:

```yaml
# Generated by helm-values-form for chart: temporal-worker
# Schema version: 0.1.0
# Only values that differ from the chart defaults are listed.
image:
  tag: 1.42.3
resources:
  limits:
    memory: 1Gi
```

Key order follows the chart schema's declaration order, not the allowlist's and
not the order fields were filled in, so a values file that lands in git does not
churn when someone reorders the allowlist.

### Quoting

The emitter quotes any string that would otherwise parse as something else. This
is the part most likely to bite, because Helm parses through
`sigs.k8s.io/yaml` -> go-yaml, a **YAML 1.1** resolver:

```yaml
podAnnotations:
  prometheus.io/scrape: 'true'   # bare true is a boolean
  example.com/note: 'yes'        # bare yes is a boolean in YAML 1.1
  prometheus.io/port: '9090'     # bare 9090 is an int
image:
  tag: '2024-01-15'              # bare, this is a timestamp
resources:
  limits:
    cpu: '2'                     # bare 2 is an int
    memory: 4Gi                  # not ambiguous, left readable
```

Kubernetes annotation values must be strings, so an unquoted `true` there is not
a cosmetic problem — it fails the chart's own schema validation. That is what the
end-to-end check exists to catch.

## Testing

```sh
npm test                    # everything
npx vitest run              # renderer, emitter, pruner, built bundle
npm run test:py             # the Python tool
npm run helm-check          # the end-to-end check
npm run helm-check:update   # regenerate tests/golden/*.yaml
```

`helm-check` is the one that matters. It drives the real pruner and the real
emitter from scripted form inputs, then:

- asserts pruning kept exactly the expected paths;
- asserts `charts/temporal-worker.schema.json` still matches the fixture chart's
  own `values.schema.json`, and that the chart's `values.yaml` defaults agree
  with the schema's;
- runs `helm lint`, which validates the emitted values against the chart's
  schema;
- runs `helm template` and byte-compares the manifests against
  `tests/golden/*.yaml`;
- renders the same overrides via `--set` and asserts the manifests are identical;
- parses the emitted YAML back with a real YAML 1.1 parser and checks it equals
  what was pruned.

Quoting, pruning, and nesting bugs all fail here, which no amount of unit testing
on the emitter can promise. CI runs it on any change under this directory.

The goldens are byte-compared against `helm template` output, so the Helm version
is part of the fixture. The workflow pins it; bumping it means regenerating the
goldens in the same commit.

`--set` and `-f` are compared with values chosen to survive Helm's `--set` type
inference. They are not always equivalent: `--set image.tag=1.10` yields the
float `1.1`, while the same value in a values file stays the string `"1.10"`.
Prefer `-f` for anything version-shaped.

### The Python tests without fastapi

`tests/test_tool.py` uses the real `fastapi` and `pydantic` when they are
importable and minimal stand-ins otherwise, so the suite runs in a bare checkout.
It reports which it used. The stand-ins are faithful about what is asserted — the
response body and headers — so a missing `Content-Disposition` still fails.

### The embedded shell

`tool/helm_values_form.py` carries a verbatim copy of `shell/form_shell.html` in
its `SHELL_HTML` constant, because the tool has to be pasteable as a single file.
The `.html` file is the source of truth:

```sh
npm run sync-shell              # copy it in
node scripts/sync-shell.mjs --check   # what CI runs
```

## Constraints worth knowing before editing

Each of these corresponds to a specific way this breaks.

1. **No `<form>`, no `type="submit"`.** Form submission inside an embed is gated
   behind a per-user setting that is off by default, so a real submit silently
   does nothing for most users.
2. **The height postMessage is mandatory.** Without same-origin access the parent
   cannot measure the iframe, and the embed is clipped to a small default height
   with a scrollbar. Report on load *and* on every resize; collapsible sections
   change the height constantly. Measure the content element, **not**
   `document.documentElement.scrollHeight` — that value is floored at the
   viewport height, so once the parent has sized the frame it can never report
   anything smaller, and a collapsed section leaves dead space forever.
3. **Inline the bundle; never `import()` it from a URL.** Opaque origin, `Origin:
   null`, permissive CORS you do not want. The cost is the byte budgets.
4. **Assume no access to the parent page.** No `localStorage`, no cookies, no
   reading Open WebUI's DOM or theme. Light/dark comes from
   `prefers-color-scheme` and nothing else.
5. **Do not rely on `window.args`.** It is only injected when the user has
   enabled same-origin access, which is off by default. All data arrives through
   the config marker.
6. **Escape the config.** Every `<` in the serialized config becomes a JSON
   unicode escape before substitution, or a chart description containing
   `</script>` ends the script tag early.
7. **No `innerHTML` for anything schema-derived.** Titles, descriptions and enum
   values come from upstream schemas nobody here controls; use `textContent` and
   `createElement`.
8. **Substitute with `str.replace`,** not an f-string or `.format()`. The shell is
   dense with braces.
9. **Every non-reserved parameter needs a `:param name:` line.** Open WebUI builds
   the model-facing schema from type hints plus those lines. Reserved arguments
   (`__event_emitter__`, `__user__`, …) are stripped automatically and must not be
   documented.
10. **Target Native (Agentic) tool calling.** Do not depend on `message`,
    `chat:message:delta`, `chat:message`, or mid-stream `replace`; those break
    under Native.
11. **Emit the short `embeds` event name.** The `chat:message:embeds` alias renders
    identically but is **not persisted**, so a reloaded chat would show the
    original live form again.

## The submission is a visible user message, by design

The YAML arrives in the transcript as the user's own message. That is intentional:
it is a record of what was configured, and the model can read it and act on it.
Open WebUI shows a confirmation dialog first, because a sandboxed frame
submitting a prompt is a cross-origin action.

If the values should stay **out** of the transcript, the alternative is to have
the iframe post an `execute` event instead, calling back into a tool that records
the values server-side. That keeps the transcript clean at the cost of the audit
trail and of the model no longer seeing what was chosen. This tool takes the
visible route; swapping it means changing the `postMessage` type in
`shell/form_shell.html` and adding the receiving tool method.

## Known limitations

- Objects nest four levels deep; deeper renders as unsupported.
- Arrays of objects are one level deep — a nested object or array inside an array
  item renders as unsupported.
- Free-form maps hold scalar values only. Charts needing a map of objects
  generally model it as an array instead.
- `anyOf`/`oneOf` with a non-scalar branch is unsupported; there is no
  "pick a branch" UI.
- `allOf` is not merged.
- `patternProperties` is not supported.
- No cross-field conditional logic (`if`/`then`, `dependentSchemas`). A field like
  `tls.secretName`, required only when `tls.enabled` is true, is enforced by the
  chart template, not by this form.
