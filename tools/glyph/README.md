# glyph

A self-contained subagent container for [Glyph](https://github.com/imaustink/glyph)
— a notes-and-tasks app. A single JSON command in, a Markdown summary out,
authenticated as the **calling user's own** delegated Glyph OAuth token, not a
shared bot credential.

It exposes create / read / update / search over both of Glyph's core resources:

- **Notes** — Glyph pages (`type: "page"`), whose body round-trips through a
  Markdown ⇆ ProseMirror converter (Glyph stores content as a ProseMirror JSON
  document; agents author it as Markdown).
- **Tasks** — Glyph's kanban tasks (title, description, status, priority, due
  date, tags).

## Contract

- **Input** (`argv[2]`): a single JSON object naming a `resource`
  (`note` | `task`) and an `action` (`create` | `get` | `update` | `search`),
  plus that operation's fields. Examples:

  ```jsonc
  {"resource":"note","action":"create","title":"Launch plan","body":"# Launch\n\n- draft copy\n- ship"}
  {"resource":"note","action":"get","id":"<uuid>"}
  {"resource":"note","action":"update","id":"<uuid>","body":"updated **body**"}
  {"resource":"note","action":"search","query":"launch","limit":10}

  {"resource":"task","action":"create","title":"Ship the PR","status":"in-progress","priority":"high","dueDate":"2026-09-15"}
  {"resource":"task","action":"get","id":"<uuid>"}
  {"resource":"task","action":"update","id":"<uuid>","status":"done"}
  {"resource":"task","action":"search","query":"ship","status":"todo"}
  ```

- **Output**: a Markdown summary of the result (a confirmation line for
  writes, the rendered note/task for reads, a bulleted list for searches),
  delivered via the event contract in [docs/messaging.md](../../docs/messaging.md).

### Fields

| Field | Notes / tasks | Values |
| ----- | ------------- | ------ |
| `title` | required on create | ≤ 500 chars |
| `body` | notes only | Markdown (headings, lists, blockquotes, code, `**bold**`/`*italic*`/`` `code` ``/`[links](url)`) |
| `description` | tasks only | ≤ 10 000 chars |
| `status` | tasks only | `todo` \| `in-progress` \| `done` \| `cancelled` |
| `priority` | both | `urgent` \| `high` \| `medium` \| `low` \| `none` |
| `dueDate` | tasks only | ISO date `YYYY-MM-DD` |
| `tags` | both | string array |
| `parentId` | notes only (create) | UUID of a parent page/folder |
| `id` | `get` / `update` | UUID |
| `query` | `search` | case-insensitive substring over title/tags (notes) or title/description/tags (tasks) |
| `limit` | `search` | max results (default 25) |

## Identity: acts as the calling user, not a shared bot

Glyph supports **per-user OAuth delegation** — an OAuth client scoped to
`page:*` / `task:*` mints a bearer token that acts as a specific user, and the
API enforces that user's own permissions (`glyph/api/internal/oauth`). This
tool is designed to run with **`Tool.spec.identityProviders: [glyph]`** set
(see `charts/community-components/templates/tool-glyph.yaml`). When a Skill
routes a call to it, `agent-orchestrator` resolves the calling user's own
linked Glyph token and injects it per-invocation as `GLYPH_TOKEN` through
`ToolRunSpec.secretEnv` (ADR 0032) — never embedding it in the `ToolRun` CR
itself, and never sharing one credential across every caller.

The blast radius of anything this tool does is therefore already bounded by
what that person can do in Glyph — the same posture as the `github` tool
(ADR 0022/0027).

> **Note:** wiring the calling user's Glyph token end-to-end additionally
> requires a `glyph` identity provider in `apps/integration-gateway` (the
> OAuth authorization-code broker that fronts Glyph's `/oauth/authorize` +
> `/oauth/token`). That gateway provider is separate infrastructure and not
> part of this tool. Until it exists, deploy with the shared-credential
> fallback below.

### Shared-credential fallback

A deployment that doesn't (yet) use per-user delegation can wire a single
operator-provisioned `GLYPH_TOKEN` secret (`glyphTool.secretKey`), exactly like
`recipe-publisher`'s `MEALIE_API_TOKEN`. The chart wires the static secret
**only** when `identityLink.enabled` is false, so a shared credential and a
per-user one are never both present in the Job.

## Safety model

1. **The calling user's own Glyph permissions are the primary boundary** —
   the token is scoped (`page:*` / `task:*`) and acts as one identity-linked
   human, not a broadly-scoped bot.
2. **Fixed target host** — `GLYPH_BASE_URL` is trusted configuration; it is
   never derived from tool input, and the HTTP client refuses to follow
   redirects (`redirect: "error"`) so a `3xx` can't re-point a request.
3. **No persisted credentials** — the token only ever lives in this process's
   env, sourced from `ToolRunSpec.secretEnv` (a per-run Secret,
   garbage-collected with the `ToolRun`), never written to disk. The root
   filesystem is read-only (`run.sh`).
4. **Redaction** (`src/security/redact.ts`) — generic `Bearer`/`token`
   credential patterns are stripped from anything that could reach a
   `progress`/`failed` event, in case Glyph's own error text echoes part of a
   request back.

## Local development

```sh
npm install
npm run typecheck --workspace=glyph
npm run test --workspace=glyph
npm run build --workspace=glyph

# Run against a Glyph instance (see .env.example):
GLYPH_BASE_URL=https://glyph.example.com GLYPH_TOKEN=... \
  npx tsx src/index.ts '{"resource":"task","action":"search","status":"todo"}'
```

Or build and run the hardened container:

```sh
docker build -f tools/glyph/Dockerfile -t glyph:latest .   # from the repo root
GLYPH_BASE_URL=... GLYPH_TOKEN=... ./tools/glyph/run.sh '{"resource":"note","action":"search","query":"launch"}'
```
