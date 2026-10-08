# ADR 0001 — Agents are Temporal workflows; tools remain Kubernetes Jobs

- Status: accepted
- Date: 2026-07-21

## Context

[agent-controller](https://github.com/imaustink/agent-controller) runs a
long-lived LangGraph.js orchestrator that resolves identity, selects a Skill
via RAG (Qdrant), plans an action, and launches work as one-shot Kubernetes
Jobs through `ToolRun`/`AgentRun` CRs reconciled by a Go core-controller.
Sub-agents are self-contained pods holding a bidirectional NATS conversation
(`ready/progress/reply/failed` up, `prompt/cancel/signal` down) with HITL
modeled as a non-final `reply` awaiting the next `prompt`.

Most of that system's coordination machinery compensates for the loop not
being durable:

- Tool results resolve **in-memory pending-promise maps** (HTTP-callback and
  NATS receivers); a restart between launch and callback loses the turn.
- `/invoke` results live in an **in-memory Map**; ADR 0006 documents the
  restart/scale-out loss.
- Sessions (active skill, continuation tokens, pending identity links) sit in
  an in-memory/Redis **SessionStore** that is explicitly best-effort.
- Sub-agent continuity is a live NATS subscription to a still-running Job,
  reconstructed each turn from the session pointer.
- The async accept/poll interface, SSE keep-alive heartbeat, device-flow
  polling, and `awaitJob`'s missing timeout are all symptoms of the same gap.
- Sub-agent recursion depth/fan-out is an acknowledged open question.

agent-controller's ADR 0002 justified LangGraph because the flow is
"stateful, branching, resumable, waiting on asynchronous Job completion
mid-turn" — which is Temporal's core product.

## Decision

Rebuild the agent half on Temporal; keep the tool half as-is.

1. **Go SDK end-to-end.** Worker (workflows + activities) and gateway are Go.
   We reuse *contracts*, not TS code: the messaging `Event` wire schema
   (`job_id`/`seq`/`ts`; `accepted|progress|warning|succeeded|failed`), the
   HMAC callback convention (`x-signature: sha256=…`,
   `Idempotency-Key: <job_id>:<seq>`), the `core.controller-agent.dev/v1alpha1`
   API group, and the Qdrant collection/payload-filter design.
2. **One long-lived `ConversationWorkflow` per chat session**, started via
   update-with-start; each user turn is a workflow Update returning the
   reply. Session state (history window, active skill, continuation tokens,
   pending identity links) lives in workflow state; idle TTL via timer;
   continue-as-new bounds history. This deletes the SessionStore, Redis, and
   the invocation map.
3. **Sub-agents are child workflows** running a shared, parameterized
   agent-loop. Agents spawning agents = child workflows spawning child
   workflows, with a depth/fan-out budget in the input and parent-close-policy
   cancellation. The `Agent` CR's orchestrator-consumed fields (`agentPrompt`,
   `skillRefs`, `model`, `maxIterations`, `allowedRoles`) parameterize the
   loop; its image/Job half goes unused.
4. **Tools remain k8s Jobs via the existing agent-controller install.** We
   depend on its Helm chart for CRDs, the core-controller, and tool images.
   An activity creates the `ToolRun` CR; the gateway's callback receiver
   verifies the HMAC event and **signals** the waiting workflow (the result
   payload only exists in the callback; the CR status phase is the crash
   backstop). The workflow awaits the signal under a durable timer — fixing
   the missing `awaitJob` timeout.
5. **Heavyweight pod agents (opencode-swe-agent) become checkpoint-resume
   Jobs.** Each work step is a one-shot Job carrying the continuation token
   (repo/branch/PR/session). To ask a human, the Job returns the question +
   token and exits; the wrapping workflow durably awaits the answer signal,
   then launches a fresh Job. No idle pods.
6. **NATS is dropped.** The bidirectional agent channel is replaced by
   workflow signals/updates; tool events arrive over the HMAC HTTP callback.

   > **Amended by [ADR 0002](0002-upstream-integration.md) D2.** This holds for
   > agents we write, and not for the ones already running. Upstream has since
   > built the live opencode tunnel (its ADR 0026), sub-agent tool calls (0028)
   > and the reply-ack hold (0033) on that channel, and `claude-code-swe-agent`
   > — which speaks it — became the production triage agent. A third execution
   > style, `BridgedAgentWorkflow`, drives an unmodified `AgentRun` over NATS
   > with a workflow holding the durable half of the conversation. Tool events
   > still arrive over the HMAC callback as stated.

## Consequences

- Durable execution replaces four ad-hoc state stores (pending-promise maps,
  invocation map, session store, live subscriptions).
- HITL and OAuth device-flow waits become `await signal` — no polling
  machinery, no pods idling on humans.
- Recursion caps, cancellation propagation, and per-run visibility come from
  the Temporal parent/child model.
- The LLM decision nodes (delegate selector, action planner, fit checkers,
  capability gate, response composer), Qdrant adapters, identity resolvers,
  and skill-access derivation must be rewritten in Go from the TS reference.
- Workflow determinism rules apply: UUIDs/timestamps via activities or
  `workflow.SideEffect`/`workflow.Now`; catalog watches stay outside
  workflows (informers → Qdrant sync process).
- Temporal payload limits (~2MB) mean large tool results eventually need the
  artifact object-store path from agent-controller's messaging roadmap.
- Streaming becomes gateway polling of a progress query (v1) instead of
  LangGraph node-transition narration.
- Upstream (non-blocking): fix core-controller's vanity module path so its
  v1alpha1 types are importable; later strip the unused AgentRun/NATS
  machinery.

## Milestones

1. ✅ Scaffold: worker + gateway, hello-world `ConversationWorkflow` (one
   turn = one Update calling one LLM activity), chart, tests.
2. ✅ Catalog + RAG: informers → Qdrant, RBAC-filtered retrieval activities,
   skill-access derivation.
3. ✅ Tool execution end-to-end: ToolRun-create activity, callback→signal
   bridge, durable await with timeout, phase-mirror crash backstop.
4. ✅ Agent-loop parity: capability gate → retrieve → select → plan⇄runTool
   loop → compose, plus the bare-answer path.
5. ✅ Conversation features: continuation tokens in workflow state, bounded
   history, OpenAI facade streaming via progress queries.
6. ✅ Sub-agents: agent-loop as child workflow parameterized by `Agent` CRs,
   depth/fan-out caps, HITL await-signal.
7. ✅ opencode adaptation: checkpoint-resume Job pattern, identity-link
   await-signal. (durable-agents side complete — see docs/pod-agents.md for
   the two upstream follow-ups: the opencode TS adapter and
   ToolRunSpec.secretEnv for per-user token injection.)
8. Hardening: payload-size guardrails, observability, chart polish.

## Upstreaming

The maintainer has agreed to take this upstream. See
[ADR 0002](0002-upstream-integration.md) for the four decisions that shapes,
and [upstream-catchup-plan.md](../upstream-catchup-plan.md) for the catch-up
against the 237 commits upstream moved after this ADR's fork point.
