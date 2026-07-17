# 0015. Post-tool response composition owned by the skill

Date: 2026-07-12

## Status

Accepted

## Context

The agent graph (ADR 0008) treats a tool's result as the final, unembellished
answer for the turn: when the action-planner chooses `call_tool`, the graph
runs the tool and the server streams its result straight back to the user.
There is no LLM step after the tool runs.

That left one workflow — the `recipe-refining-skill` — needing the user to be
asked to confirm before the first Mealie publish. With no post-tool step, the
only place to add the prompt was the agent graph itself, so it grew a
hard-coded special case:

```ts
const RECIPE_SCRAPER_TOOL_ID = "recipe-scraper";
const CONFIRM_PUBLISH_PROMPT = "\n\n---\nReply to confirm publishing this to Mealie, ...";
// ...after any tool succeeds:
result = tool.id === RECIPE_SCRAPER_TOOL_ID && typeof event.result === "string"
  ? `${event.result}${CONFIRM_PUBLISH_PROMPT}`
  : event.result;
```

This coupled a generic orchestrator to one tool id and one skill's Mealie
workflow — the opposite of the rest of the system, where tools and skills are
inert, data-driven CRDs and the orchestrator stays generic (ADR 0010, 0011).
The skill's own markdown even had to reference the behavior ("its result will
already ask… you don't need to add that"), splitting one decision across code
and data.

A naive fix — let an LLM rewrite the tool output — is unsafe here: the recipe
workflow relies on the tool's Markdown, including its
`<!-- mealie-slug: … -->` marker, surviving **verbatim** across turns so the
next turn can detect the current recipe and whether it is already published.

## Decision

Add a generic **`composeResponse`** node that runs after a successful tool
call, driven by a new **`ResponseComposer`** port
(`src/agent/response-composer.ts`, `OpenAiResponseComposer` implementation).
The active skill's own markdown decides whether to add any follow-up around
the tool's result.

- The composer receives the skill markdown (trusted, catalog-authored) and the
  tool output (untrusted data) and returns only additive
  `{ prefix, suffix }` narration — it is never given permission to rewrite the
  output. The graph concatenates `prefix + rawResult + suffix`, so the tool
  Markdown and its slug marker are preserved byte-for-byte.
- Only string results are narrated in place; a structured (JSON) result skips
  the composer and passes straight through.
- The recipe-refining-skill markdown now owns the confirm-publish nudge (an
  "After a tool runs" section), and the hard-coded `recipe-scraper` /
  `CONFIRM_PUBLISH_PROMPT` special case is deleted from the graph.
- The graph node that runs a tool was renamed `launchJob` → `runTool` (it also
  runs in-pod LocalTools, ADR 0014, not only Jobs), and the container-launch
  port `JobLauncher` → `ContainerToolLauncher` — neither the orchestrator nor
  this port ever creates a k8s Job; container tools are launched as `ToolRun`
  CRs and the Go core-controller reconciles the Job (ADR 0010). The superseded
  direct-Job `K8sJobLauncher`, the `ManifestToolRegistry` (ADR 0009), the
  annotated-Deployment `K8sAnnotationToolRegistry` (ADR 0004), and the static
  `skills/catalog.ts` (ADR 0008) were removed.

## Consequences

- The orchestrator is generic again: no tool ids or skill-specific prompts in
  the agent graph. New skills add follow-up narration through their own
  markdown, with no code change.
- One extra LLM call per successful tool turn. The composer returns empty
  narration when the skill wants none, so behavior is unchanged for skills that
  don't ask for a follow-up; this can be gated per-skill later if cost matters.
- Tool output is guaranteed verbatim (the composer only wraps it), so the
  recipe workflow's slug-marker detection keeps working across turns.
- The blocking and `/invoke` (ADR 0006) surfaces read the final `state.result`
  unchanged; the streaming surface now finishes on `composeResponse` and
  accumulates `result` across `runTool` + `composeResponse` (the latter emits an
  empty update when it adds nothing).
