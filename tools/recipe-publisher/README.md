# recipe-publisher

> One tool container in the [controller-agent](../../README.md) collection. Shared
> conventions (the event protocol and security model every tool follows) live at
> the repo root: [docs/messaging.md](../../docs/messaging.md) and
> [docs/security.md](../../docs/security.md).

A self-contained, security-hardened **subagent container** that publishes a
recipe (as the Markdown [recipe-scraper](../recipe-scraper/) produces) to a
[Mealie](https://mealie.io/) instance. One Markdown document goes in; a new
(or updated) Mealie recipe comes out.

It exists to pair with recipe-scraper as the two tools behind the
**Recipe Refining** skill (see
[docs/adr/0008-skill-mediated-tool-retrieval.md](../../docs/adr/0008-skill-mediated-tool-retrieval.md)):
extract → confirm once → publish to Mealie → every further refinement is
pushed straight to that same Mealie recipe.

## What it does

Given a recipe Markdown document (as a single CLI argument), the container:

1. **Validates** the input is non-empty text — treated as untrusted input
   even though it comes from the parent agent (defense in depth, same
   discipline as recipe-scraper's own inputs).
2. **Strips a leading `<!-- mealie-slug: <slug> -->` marker**, if present
   (carried forward from a previous publish's own response — see "Updating
   an already-published recipe" below), then **parses** the remaining
   Markdown back into structured data (title, ingredient/direction sections,
   equipment, tips, source URL) — the inverse of recipe-scraper's renderer
   (`tools/recipe-scraper/src/markdown.ts`).
3. **Creates a new recipe** in Mealie by name (`POST /api/recipes`, which
   assigns the slug) — or, if a marker was present, **updates that existing
   recipe in place** via `PATCH` instead, skipping the create step entirely.
   Either way it then **patches** in:
   - ingredients, run through Mealie's own ingredient parser
     (`POST /api/parser/ingredients`) so quantity/unit/food come out as real
     structured fields (enabling unit conversion, recipe scaling, and
     shopping-list quantities) instead of one opaque note string — falls
     back to a plain note per line if the parser can't parse it or the call
     itself fails;
   - equipment, resolved to Mealie's first-class `RecipeTool` entities
     (looked up by name, created if missing) instead of freeform text —
     anything that can't be resolved falls back to an "Equipment" note;
   - instructions, tips (as notes), and the source URL.
4. **Emits** the result as a plain Markdown string: the recipe content that
   was just pushed, prefixed with a `<!-- mealie-slug: ... -->` marker
   (invisible when rendered) and followed by a confirmation + Mealie link
   (`✅ Published`/`✅ Updated on Mealie: [Title](url)`), or a `failed` event
   on error — see [docs/messaging.md](../../docs/messaging.md).

The target Mealie instance (`MEALIE_BASE_URL`) is **fixed via environment
configuration** and is never taken from the input Markdown or any caller/LLM
input — this is a deliberate security boundary, not an oversight.

Ingredient/direction subsections (`### Section Name`, for multi-component
recipes) are mapped onto Mealie's own section-header conventions: a
header-only `recipeIngredient` entry (just a `title`) per section, and a
shared `title` on each `recipeInstructions` step in that section.

## Updating an already-published recipe

This tool is an **upsert**, not create-only. To update a recipe instead of
creating a duplicate, prefix the input Markdown with the exact marker line
this tool emitted the first time it published that recipe:

```
<!-- mealie-slug: birria-tacos -->

# Birria Tacos
...
```

The marker is stripped before parsing and is never itself part of the recipe
content. The orchestrator's recipe-refining skill handles this automatically
(the marker round-trips through the chat's `<conversation_history>`
fold), so this only matters if you're calling the tool directly.

## Deploying to Kubernetes

In-cluster, this tool is never a long-running Deployment — the
[tool-controller](../../controllers/tool-controller/) launches it as a
one-shot Job per invocation, based on the [`Tool` custom resource](tool.yaml)
(ADR 0010). Prerequisites: the
[tool-controller](../../charts/tool-controller/) and
[agent-orchestrator](../../charts/agent-orchestrator/README.md) charts are
already installed. Then, from the repo root:

### 1. Build the image into the cluster

The Job spec uses `image: recipe-publisher:latest` with
`imagePullPolicy: IfNotPresent`, so for a local minikube cluster build
straight into its Docker daemon (no registry push needed):

```bash
eval $(minikube docker-env)
docker build -f tools/recipe-publisher/Dockerfile -t recipe-publisher:latest .
```

### 2. Create the ServiceAccount

The Job runs as the `serviceAccountName` named in [tool.yaml](tool.yaml) —
it must already exist in the target namespace (nothing in this repo creates
tool ServiceAccounts):

```bash
kubectl -n controller-agent create serviceaccount recipe-publisher
```

### 3. Create the secret

`MEALIE_API_TOKEN` is injected into the Job via the `secretEnv` reference in
[tool.yaml](tool.yaml) — the token itself never appears in the Tool CR.
Create a long-lived API token in the Mealie UI (`/user/profile/api-tokens`),
then:

```bash
kubectl -n controller-agent create secret generic recipe-publisher-secrets \
  --from-literal=MEALIE_API_TOKEN=<your-mealie-api-token>
```

(Run this yourself in a terminal rather than pasting the token anywhere it
gets logged; see [docs/security.md](../../docs/security.md) on secret
handling.)

### 4. Apply the Tool custom resource

Edit `MEALIE_BASE_URL` in [tool.yaml](tool.yaml) to point at your Mealie
instance first, then:

```bash
kubectl -n controller-agent apply -f tools/recipe-publisher/tool.yaml
```

### 5. Restart the orchestrator

The orchestrator reads the Tool catalog once at startup (no live watch), so
a new or changed Tool CR isn't picked up until it restarts:

```bash
kubectl -n controller-agent rollout restart deployment/agent-orchestrator
```

After a rebuild of the image (step 1) with the same `latest` tag, no restart
of anything is needed — the next launched Job picks up the new image — but
re-apply `tool.yaml` + restart the orchestrator whenever the CR's
description/input/output text changes, since those feed the RAG index.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `1`  | General/unexpected error |
| `2`  | Usage error (missing input, missing required config) |
| `3`  | Input does not match the expected recipe markdown shape |
| `4`  | Mealie API call failed |

## Configuration

| Env var | Default | Notes |
| ------- | ------- | ----- |
| `MEALIE_BASE_URL` | *(required)* | No trailing slash |
| `MEALIE_API_TOKEN` | *(required)* | Never logged/echoed — see [docs/security.md](../../docs/security.md) |
| `MEALIE_INGREDIENT_PARSER` | `nlp` | Which of Mealie's registered parsers to use (`nlp` \| `brute` \| `openai`) |
| `RECIPE_CALLBACK_URL` / `RECIPE_CALLBACK_SECRET` | — | Injected automatically by the tool-controller; do not set manually |

## Security model

- Treats the input recipe Markdown as untrusted, even though it's produced by
  the parent agent — re-validated before any Mealie call.
- `MEALIE_API_TOKEN` is redacted from all logs/events (`src/security/redact.ts`,
  via the generic `Bearer <token>` pattern shared with recipe-scraper).
- All outbound requests target a single fixed host (`MEALIE_BASE_URL`) and
  use `redirect: "error"` — no redirects are ever followed.
- The publish target (the Mealie instance itself) is fixed server-side
  configuration, never derived from the input Markdown or caller/LLM input.
- Container hardening matches recipe-scraper's: non-root user, dropped
  capabilities, read-only root filesystem, resource limits (see `run.sh`).
- **The `mealie-slug` update marker is only as trustworthy as the chat
  history it round-trips through**, which can include untrusted scraped
  recipe content earlier in the same conversation. A sufficiently effective
  prompt injection could in principle cause the assistant to echo back a
  different, attacker-chosen slug, causing an unintended overwrite of a
  different existing recipe. Blast radius is bounded to recipes within the
  same authenticated Mealie account/group (`MEALIE_API_TOKEN` can't reach
  other tenants) — a known, accepted risk, not silently ignored (see
  `mealie/markdown-parser.ts`).

## Known gaps

- Ingredient parsing quality depends on Mealie's own parser (`nlp` by
  default) — it won't always correctly split quantity/unit/food from
  recipe-scraper's free text, and anything it can't parse falls back to an
  unstructured note.
- Equipment/tool matching is name-based (case-insensitive exact match) — near
  duplicates ("stand mixer" vs "stand-mixer") will create separate tools
  rather than being merged.
- Update-in-place relies on the caller (the orchestrator's skill, or whoever
  invokes this tool directly) correctly carrying the `mealie-slug` marker
  forward verbatim — losing or corrupting it results in a duplicate recipe
  being created instead of the existing one being updated.

## Project layout

```
tools/recipe-publisher/
  src/
    index.ts                    # entrypoint: parse/validate input, publish, emit result
    config.ts                   # env var configuration
    schema.ts                   # local Markdown input / PublishResult zod schemas
    mealie/client.ts             # Mealie create+patch publish logic
    mealie/markdown-parser.ts    # parses recipe-scraper's Markdown back into structured data
    security/redact.ts           # secret redaction (shared generic patterns)
    messaging/index.ts           # @controller-agent/messaging wiring (JobEmitter subclass, createSink)
  Dockerfile
  tool.yaml                      # Tool custom resource (ADR 0010) — see "Deploying to Kubernetes"
```

