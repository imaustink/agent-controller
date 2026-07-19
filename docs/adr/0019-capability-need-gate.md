# 0019. Capability-need gate before catalog retrieval

Status: accepted

## Context

Every turn unconditionally flows through `resolveIdentity -> checkActiveSkill
-> checkActiveAgentRun -> retrieveSkills -> retrieveAgents -> selectDelegate`
(`graph.ts`) — there was no step asking whether the request plausibly needed
a specialized skill/tool/agent at all before spending an embedding + RAG
round trip over both catalogs. For a purely conversational request ("what's
a good substitute for buttermilk?", "tell me a joke"), that retrieval
predictably finds nothing, and `selectDelegate` falls into
`noMatchFallback`: it answers via `bestEffortResponder` and unconditionally
appends `SELF_IMPROVEMENT_FOOTER`, inviting the user to "ask me to run the
self-improvement skill" for a request that was never a candidate for one.

That footer conflates two very different situations under one code path:
"we genuinely searched the catalogs and found nothing suitable" (a real gap
worth turning into a skill) versus "this was never going to match anything
because it didn't need a capability in the first place" (there is nothing
to add). The latter is pure noise — unnecessary retrieval work on every
conversational turn, and a suggestion that makes no sense to the user.

## Decision

Add a cheap classifier gate, `CapabilityNeedChecker`
(`src/agent/capability-need-checker.ts`), following the same
Structured-Outputs LLM-judge pattern as `SkillFitChecker`/`ToolFitChecker`:
a single boolean, `needsCapability(request)`, judging whether the request
plausibly requires an external action or specialized capability as opposed
to being answerable directly from general conversation.

- **New node `checkNeedsCapability`**, inserted between
  `checkActiveAgentRun` and `retrieveSkills`. Runs only after every
  session-continuity check has missed (an active skill/agent already in
  progress always takes priority, unaffected by this gate).
- **`false` short-circuits to a new `bareAnswer` node**: the same
  `bestEffortResponder` call `noMatchFallback` already makes (factored into
  a shared `callBestEffort` helper), but with **no** `SELF_IMPROVEMENT_FOOTER`
  appended and `wasFallback` left `false` — this path never attempted a
  catalog search, so there is nothing to suggest turning into a skill.
  `retrieveSkills`/`retrieveAgents`/`selectDelegate` are skipped entirely.
- **`true` (or a classifier error) proceeds exactly as before** — full
  retrieval, selection, and the existing `noMatchFallback` cascade
  (fallback-tool-fit, then bare answer + footer) for the case where a real
  search genuinely came up empty.
- **Default on ambiguity/parse failure is `true`** (needs capability) — the
  opposite default from `SkillFitChecker`/`ToolFitChecker`, which default to
  "reject". Here the safe fallback is the graph's *existing* behavior
  (always search); a false negative only costs one unneeded retrieval round
  trip, while a false positive would incorrectly skip real tool discovery.

## Consequences

- Purely conversational turns no longer pay for an embedding + RAG round
  trip over the skill and agent catalogs, and no longer end with a
  nonsensical "want a permanent skill for this?" suggestion.
- One additional lightweight LLM call per turn (skipped entirely on the
  `checkActiveSkill`/`checkActiveAgentRun` hit paths, which is the common
  case for an ongoing conversation) — negligible next to the retrieval +
  selection calls it replaces on a miss.
- `AgentGraphDeps.capabilityNeedChecker` is now required, mirroring
  `toolFitChecker`/`bestEffortResponder` — every caller of `buildAgentGraph`
  (currently just `src/index.ts`) must supply it.
- The self-improvement suggestion (`SELF_IMPROVEMENT_FOOTER`) now only ever
  appears when a real catalog search ran and found nothing — restoring its
  intended meaning of "there's a genuine gap here."
