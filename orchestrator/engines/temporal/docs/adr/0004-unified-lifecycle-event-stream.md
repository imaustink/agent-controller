# ADR 0004 — Unified, replayable lifecycle event stream

- Status: accepted
- Date: 2026-10-05

## Context

[temporal-agent-harness](https://github.com/temporal-community/temporal-agent-harness)
exposes a single standardized, replayable event stream covering the whole agent
lifecycle. This engine instead has **two parallel, mismatched event models**:

- **Typed tool stream** — `messaging.Event` (`internal/messaging/event.go`):
  enum kinds (`accepted`/`progress`/`warning`/`succeeded`/`failed`), `Seq`,
  `TS`, per-type validation, HMAC-signed, and **durable** (arrives as
  `tool-event::<jobID>` signals recorded in workflow event history).
- **User-facing narration** — `TurnProgress` + `note()`
  (`conversation.go:41-50, 299-328`): a plain `[]string`, no kinds, no seq,
  **non-durable** (a per-run local variable explicitly discarded on
  continue-as-new), surfaced via the `turn-progress` query the gateway polls at
  700ms.

The end client only ever sees the narration model. The rich typed tool event is
**flattened to a single string** at `agentloop.go:833-839`, discarding `Pct`,
`Artifacts`, and the event `Type`. Narration is lossy by construction: a worker
crash mid-turn rebuilds the buffer only via replay, continue-as-new starts it
empty, and the SSE `seen` cursor is per-connection with no resume
(`server.go:593`). The clearest symptom is that `RemoteControlUrl` had to be
hand-promoted out of narration into durable `ConversationState`
(`conversation.go:342-348`) because the general mechanism cannot carry anything
that must survive a turn.

Three schemas need reconciling eventually: `messaging.Event`, `AgentUp`
(no seq, `agent_workflow.go`), and the NATS-bridged `UpMessage`
(`internal/agentrun/protocol.go`, has its own Seq/TS/Type).

## Decision

Generalize the existing `messaging.Event` schema into one canonical lifecycle
envelope and make the user-facing stream durable and offset-addressable.

1. **One envelope.** Extend the `messaging` kind set with turn-level kinds
   (`turn-started`, `skill-selected`, `tool-started`, `tool-finished`,
   `turn-completed`) alongside the tool-level ones. Everything `note()` emits
   becomes a typed event; the gateway down-converts to `[]string` for legacy
   OpenAI clients at the edge, not in the core. This retires the lossy flatten
   at `agentloop.go:833-839`.
2. **Durable, offset-addressable log.** Replace the non-durable `progress.Lines`
   local var with a bounded append-only event log in `ConversationState`
   (trimmed like `History`), each event carrying a monotonic turn-scoped offset.
   This generalizes away the `RemoteControlUrl` special-case and survives
   continue-as-new and mid-turn replay.
3. **Resume, then push.** With a durable offset log, the gateway SSE/`/invoke`
   paths serve "events after offset N" for resume-after-disconnect instead of a
   per-connection cursor.

## Consequences

- One event schema instead of three; tool richness (stage, pct, artifacts, code)
  reaches the client instead of being stringified away.
- Event-history growth must be bounded: the durable log is trimmed and dropped at
  continue-as-new boundaries.
- Determinism holds — events are built in workflow code; no field may derive from
  wall-clock or other non-replayable sources.
- Token-level model streaming is explicitly **out of scope** (Temporal
  activities don't stream out of the box); flagged as future research, not
  committed here.

## Governance

Applied to **both engines**: the unified `TurnEvent` envelope is defined once in
the shared `@controller-agent/messaging` contract (and its Go port), and each
engine emits it. Although the two engines stream over different machinery
(Temporal queries/signals vs. LangGraph node transitions), the event *schema*
the client observes is identical, so a consumer cannot tell them apart.

## Milestones

1. B1 — Typed envelope, same transport: introduce the unified event type, make
   `note()` emit typed events, down-convert at the gateway. Behavior-preserving,
   parity-safe. (Spike landed alongside this ADR: `messaging/turnevent.go`.)
2. B2 — Durable offset log in `ConversationState`; retire the `RemoteControlUrl`
   special-case.
3. B3 — Offset-based resume/push on the SSE and `/invoke` paths.
4. B4 — (stretch/research) token-level model streaming.
