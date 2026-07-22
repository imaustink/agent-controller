# Pod agents: the checkpoint-resume contract

Heavyweight agents that need a real container environment (opencode-swe-agent
running git + a coding CLI) don't fit the declarative `AgentWorkflow` loop.
In agent-controller they ran as long-lived `AgentRun` Jobs holding a
bidirectional NATS conversation — including idling alive while a human
answered `session.ask()`. Here they become **checkpoint-resume Jobs**:

- Each work step is one ordinary tool Job (a `ToolRun`), launched by
  `PodAgentWorkflow` and reported over the ordinary HMAC event stream.
- A step that needs the human returns a **question envelope** and exits.
  The workflow waits durably; nothing runs while the human thinks.
- The next step is a fresh Job carrying the agent's continuation token, so
  state rides git/the token (branch-as-state), never a live process.

## Wiring an agent

1. Ship the agent's step image as a **Tool CR** (e.g. `swe-step`). It is a
   normal tool: input on argv, events to `RECIPE_CALLBACK_URL`, HMAC-signed.
   It needn't be retrievable — no skill has to reference it.
2. Declare the **Agent CR** as usual (description, allowedRoles,
   orchestratorPrompt, identityProviders…) and add the annotation:

   ```yaml
   metadata:
     annotations:
       durable-agents.dev/step-tool: swe-step
   ```

   catalog-sync decodes this into `AgentDescriptor.StepToolRef`, which
   routes delegation to `PodAgentWorkflow` instead of the declarative loop.

## The step contract (what the image must do)

Input: argv[1] is the step input. It may begin with a leading
`<!-- continuation: <token> -->` marker — the agent's own opaque resume
state from the previous step (strip it; its content is yours). The first
step of an episode gets the user's goal; later steps get the user's answer
to your question.

Output: emit the usual `accepted → progress* → succeeded|failed` stream.
The `succeeded` event's `result` is the envelope:

```json
{
  "status": "question" | "final",
  "message": "the question for the user, or the final answer",
  "continuation": "opaque resume token (repo/branch/PR/session…)"
}
```

Then **exit 0**. `status: "question"` means: the workflow relays `message`
to the user, waits (hours are fine — no pod exists), and launches the next
step with the answer + your `continuation`. `status: "final"` ends the
episode; the token is banked per-agent in the conversation and prepended to
this agent's next episode.

A plain string `result` is treated as `{"status": "final"}` — any ordinary
tool can serve as a degenerate one-shot agent.

## Identity gate

If the Agent CR declares `identityProviders`, `PodAgentWorkflow` checks the
caller's linked credentials before the first step (fail closed). Missing →
the turn's reply is the link instruction and the workflow waits; every user
reply re-checks. Dev store: `IDENTITY_LINKS` / `IDENTITY_LINK_URLS` env
JSON on the worker.

## Adapting opencode-swe-agent (upstream follow-ups)

The current image speaks `@controller-agent/agent-runtime` (NATS). The
adapter change: replace `runAgent(handler)` with the tool contract —
`extractContinuationToken(argv[1])` (already exists as `marker.ts` +
`continuation.ts` logic), run one opencode step, and emit the envelope via
the existing `@controller-agent/messaging` CallbackSink instead of a NATS
reply. `session.ask()` becomes "return a question envelope and exit."

Known upstream gaps, deliberately not worked around here:

1. **Per-user token injection**: upstream `AgentRunSpec.secretEnv` injected
   the caller's GitHub token per run. `ToolRunSpec` has no `secretEnv`, so
   per-user credentials can't ride the step Job yet — the identity gate
   works, injection needs a small upstream `ToolRunSpec.secretEnv` addition
   (mirroring AgentRun's) plus a launcher field.
2. **opencode image adaptation** as described above — TypeScript changes in
   the agent-controller repo.
