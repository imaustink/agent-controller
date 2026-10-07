# ADR 0003 — Declarative tool-approval policy (human-in-the-loop on execution)

- Status: accepted
- Date: 2026-10-05

## Context

[temporal-agent-harness](https://github.com/temporal-community/temporal-agent-harness)
(Temporal's own experimental agent framework) ships a tiered, declarative
**tool-approval policy**: tools are classified, safe ones run silently, unsafe
ones require human approval before execution, and an optional evaluator can
auto-approve with escalation to a human on uncertainty. The policy is data,
separate from agent code.

This engine has **no equivalent today**. The only "stop and ask a human" is the
LLM-chosen `ask_user` action inside the sub-agent loop
(`internal/temporal/workflows/agent_workflow.go`), which is prompt-driven — the
model decides, and nothing deterministically gates a tool from running. A
destructive tool executes the moment the planner selects it and its identity
gate passes.

Two existing mechanisms make this cheap to build, if joined:

- **The deterministic-gate doctrine** (ADR 0030 upstream, mirrored in
  `internal/authz`): authorization is a single-owner, plain-control-flow
  decision; **no model call participates**. This is the pattern an approval gate
  must follow so a planner can never skip or reorder it.
- **The durable human-wait mechanism** already exists: `AgentPromptSignal` +
  `prompts.Receive(ctx)` (`agent_workflow.go`) plus the active-episode resume
  branch (`agentloop.go:83-106`) let a workflow block on a human answer with no
  pod idling. `ask_user` already rides it.

Per the project's standing guidance (deterministic over prompt for core
behavior), the default decision path must be deterministic/plumbed. An
LLM-judged auto-approve tier is acceptable only as opt-in.

## Decision

Introduce a declarative, deterministic tool-approval policy enforced at the
single tool-dispatch choke point, reusing the existing durable human-wait.

1. **Policy on the CR, decided in code.** Add a dedicated `approval` enum field
   to the `Tool`, `LocalTool`, and `MCPTool` CRDs, mirrored in the Go
   `toolSpec`/`localToolSpec`/`mcpToolSpec` decode (`internal/catalog/decode.go`)
   and `ToolDescriptor` (`descriptors.go`), the TS CR types, and the chart CRDs.
   A dedicated field is chosen over repurposing the ambiguous, dead `tier` field:
   overloading a field named `tier` with approval semantics would surprise
   operators and couple two unrelated concerns. Values:
   - `never` (and the empty default) — pre-approved, runs silently. Empty
     defaults to `never` so **no existing CR changes behavior**.
   - `always` — requires human approval before execution.
   - `auto` — (opt-in, phase A3) consult an evaluator; escalate to human on
     uncertainty.
   A coarser `approvalDefault` sits on the `Agent` CRD; resolution is
   most-specific-wins (tool field overrides agent default). Caller tools
   (ADR 0035) are out of scope — the client both supplies and runs them.

2. **One choke point.** Enforce immediately after the tool descriptor is
   resolved and re-validated in scope — `tool := *findTool(...)`
   (`agentloop.go:420`) — which sits ahead of every server-side execution branch
   (knowledge-base, MCP, container, local, agent-backed), and mirror it in the
   sub-agent loop (`agent_workflow.go`, the `AgentActionCallTool` branch). At that
   point `ToolID`, `ToolInput`, and the resolved descriptor are all in hand.

3. **Human approval across turns, matching the existing HITL idiom.** On
   "approval required," record a `PendingApproval` on `ConversationState` and
   return the turn with an approval prompt as the reply — exactly how `ask_user`
   and an active sub-agent episode already pause and resume across turns. The
   next turn's message is interpreted deterministically as approve/deny (a
   control message, *not* appended as a normal user turn); approve executes the
   stored call and resumes the loop, deny synthesizes a `failed`-shaped tool
   result the planner can react to — never a silent drop. A `pending-approval`
   query exposes the pending call so the gateway can render an affordance.

4. **Deterministic and unskippable.** The gate is workflow control flow (already
   in event history); the planner cannot elect to skip it. An LLM is consulted
   only for the opt-in `auto` tier, and even then only to *tighten*, never to
   bypass, the human gate.

## Consequences

- First safety feature where Temporal is deliberately ahead of the LangGraph/TS
  reference (cf. repo-read gate, parity audit #19). Because approval is
  product-visible and safety-relevant, the CR schema is defined engine-neutrally
  and an upstream parity item is filed so the two engines cannot silently
  diverge on it. See **Governance** below.
- No new idle-pod cost: approvals reuse the `prompts.Receive` durable wait.
- Approval surfaces to the user as a turn reply they answer next turn (identical
  UX contract to `ask_user`); a richer approval UI can come later.
- A declarative `sideEffecting`/non-idempotent marker may be unified with this
  field, replacing the per-call-site hardcoded `MaximumAttempts:1`
  (`agentloop.go:888`). Deferred unless it falls out naturally.

## Governance

Implemented in **both engines** in lockstep against one shared contract: the
`approval` field is defined once on the CRDs, and the Temporal (Go) and
LangGraph (TS) loops enforce identical semantics at the top-level conversation
path (resolution precedence, decision parsing, prompt wording, deny result). This
keeps a safety behavior from diverging between engines. The CR field
names/semantics are frozen in this ADR; the parity audit gains a matching entry.

**One deliberate v1 asymmetry:** the sub-agent loop (an Agent's own `toolRefs`,
ADR 0028) does a real HITL round-trip in Go (durable wait) but FAILS CLOSED in TS
(no resume channel in that synchronous path) — both fail safe, but a TS sub-agent
cannot yet pause-and-approve. Tracked in parity-audit #20; closing it needs a
durable resume channel in the TS sub-agent dispatch.

## Milestones

1. A1 — Schema + deterministic gate: field through decode→descriptor, enforce
   `never`/`always`, deny-path result. No human wait yet. Fully testable.
2. A2 — Human approval loop: approval request/decision signals, resume-branch
   wiring, gateway surfacing of pending-approval state.
3. A3 — (opt-in) auto-evaluator tier behind `auto`, escalating to A2 on low
   confidence.

Each milestone ships independently, with tests that can actually fail (e.g.
prove an `always` tool is blocked when no decision signal arrives).
