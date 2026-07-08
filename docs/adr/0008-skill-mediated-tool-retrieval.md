# 0008: Skill-mediated dynamic tool retrieval supersedes flat tool RAG

**Status:** accepted

> **Editorial notes:** the static `catalog.ts` skill source described here
> was later replaced by `Skill` custom resources ([ADR 0010](0010-crd-catalog-and-tool-controller.md));
> skills' own `allowedRoles` retrieval filter was later removed in favor of
> an audience derived from the referenced tools' roles ([ADR 0011](0011-skill-access-derived-from-tools.md)).
> The skill-mediation flow itself is unchanged.

## Context

ADR 0003/0004 gave the agent a single flat RAG index over tool descriptors:
every request was embedded, searched against the whole tool catalog, and an
LLM (`OpenAiToolSelector`) picked exactly one candidate to launch as a Job.
This worked for single-shot "one request -> one tool" flows, but it doesn't
scale to a request that legitimately needs *procedural guidance* (which tool
to use for which sub-step, in what order, with what data) or that sometimes
shouldn't launch a tool at all (e.g. a purely conversational follow-up).

A concrete motivating case: extracting a recipe (`recipe-scraper`), letting
the user iteratively adjust it in conversation (no tool call — the LLM edits
the recipe JSON directly), and finally publishing it (`recipe-publisher`).
A flat tool-RAG step has nowhere to put "here's how these two tools relate
and when each applies," and no path for "don't call a tool this turn."

Options considered for organizing this:

- **Keep flat tool RAG, add ad-hoc prompt engineering per tool** — rejected:
  doesn't compose; every new multi-tool workflow would need bespoke prompt
  logic wedged into the single tool-selection step.
- **A `Skill` layer between the request and tool retrieval** — chosen: a
  skill is RAG-matched against the request first (its own Qdrant collection,
  mirroring ADR 0003's `VectorStore` port pattern); the winning skill's
  markdown is injected as system-prompt context and its declared `toolIds`
  become the *only* tools eligible this turn. A new "action planner" step
  then decides, in light of that skill's instructions, whether to respond
  directly or call one of those tools.

For the skill catalog's source, the same two options from ADR 0004 came up
again (static list vs. dynamic cluster discovery). Unlike tools, skills are
not "is this thing actually deployed" facts — they're authored procedural
guidance — so a small **static, hand-authored catalog** (`src/skills/catalog.ts`)
was chosen over inventing a new discovery mechanism (CRD/annotations) for a
single demo skill. This can be revisited if the catalog grows large enough
to need externalized authoring.

## Decision

Every request now flows through: retrieve candidate skills (RBAC-filtered,
fail closed exactly like tool retrieval) -> select one skill (LLM, Structured
Outputs, same discipline as the old tool selector) -> resolve that skill's
declared `toolIds` directly (no re-ranking — `VectorStore.getByIds`, still
RBAC re-checked) -> plan an action (`OpenAiActionPlanner`, skill markdown
injected as trusted system-prompt content) -> either respond directly (no Job
launched) or launch exactly one of the skill's tools as a Job.

This **replaces** (not augments) the previous `retrieveTools`/`selectTool`
graph nodes and `OpenAiToolSelector` class, which are removed. Multi-turn
conversations (e.g. "adjust the recipe, then publish it") remain **stateless**
on the server: the caller round-trips the current recipe JSON in each
message; there is no new session/conversation store. *(Partially revisited by
ADR 0012: skill **routing** now has session-scoped continuity — a
conversation keeps its active skill across turns, re-evaluated by a per-turn
fit-check — but conversation content remains stateless as decided here.)*

v1 supports selecting a **single** skill per turn — a multi-skill (union of
markdown/tools across several matched skills) mode was considered but not
built; see Consequences.

## Consequences

- A skill author can encode multi-step, multi-tool procedural knowledge
  (order of operations, which tool for which sub-task, when *not* to call a
  tool) in one place (the skill's `markdown`), instead of it being implicit
  in a single flat tool-selection prompt.
- Adds a new component (`SkillStore`/`QdrantSkillStore`, its own Qdrant
  collection) and a new startup reconcile step (upsert the static catalog),
  mirroring the existing tool-store reconcile.
- Adds `VectorStore.getByIds` — a second query mode alongside semantic
  `query`, used when the caller (a skill) already knows exactly which tool
  ids it wants, rather than re-ranking.
- A request that matches no skill now fails closed with "no matching skill
  for this request" — there is no fallback to the old flat tool-RAG
  behavior. If a use case doesn't fit any authored skill, it currently has no
  path to a tool at all; a new skill must be authored for it.
- The `OpenAiActionPlanner`'s Structured Outputs constrain the *shape* of its
  decision, but the graph node still re-validates that a returned `tool_id`
  is actually one of the skill's resolved tools before acting on it — the
  planner's output is not implicitly trusted.
- Single-skill-per-turn (v1) means a request spanning two unrelated skills in
  one turn isn't supported; the user must address them as separate requests.
  Multi-skill merging (union of markdown + tool lists) is a documented
  follow-up, not implemented.
- Stateless multi-turn editing is simple to build but pushes the "remember
  the current recipe" burden onto the caller/chat client — a real
  conversation-memory feature (already a documented gap per ADR 0007) would
  remove this, but is out of scope here. *(ADR 0012 later added session
  continuity for the active skill id only — the content burden described
  here still stands.)*
