# 0033. An agent turn survives losing the orchestrator that was waiting on it

Date: 2026-07-26

## Status

Accepted

Completes the fix begun in "Fix agent turns failing on orchestrator rollout, not
on any timeout" (`55b0e4b`), which made the failure honest but did not remove it.

## Context

An agent turn's work lives in its own Job pod. The turn's *wait* lives in an
orchestrator pod: one HTTP request parked on `awaitReply`, holding a core NATS
subscription to the run's up subject. Those two lifetimes are unrelated, and the
second is far shorter than the first.

`release.yml` deploys on every push to `main`, and each deploy restarts
agent-orchestrator. The incident that prompted `55b0e4b` recorded eleven
rollouts in fourteen hours. Any agent turn in flight during any of them is a
turn whose waiter disappears.

`55b0e4b` fixed three real defects — a bound that was never armed, NATS drained
in the same `Promise.all` as the HTTP close, and every failure relabelled as a
timeout — and added a bounded drain (`shutdownDrainMs`, 25s, sized under the
pod's 30s termination grace period). What it could not fix is the shape of the
problem:

- an agent turn takes minutes; the drain gives it 25 seconds;
- past that, `awaitReply` throws `AgentTurnTransportError` and the turn fails
  while the run goes on to succeed;
- core NATS has no durability, so the `reply` the agent publishes into that gap
  is **discarded** — there is no subscriber. Even a replacement orchestrator
  re-subscribing to the (deterministic) subject one second later gets nothing.

So the honest message was still reporting a real loss. The answer existed, was
correct, and was unrecoverable. Meanwhile the chat path had a session record
that could have anchored a resume, and the GitHub path already sends a stable
per-issue `session_id` — the pieces were there; nothing joined them.

The obvious fix is durability at the transport: JetStream over `agent.*.up`,
consumed by a per-run durable consumer. The deployed NATS has no `jetstream`
block in its config, so this means enabling JetStream on the shared server,
provisioning storage, and moving both sides onto a stream — infrastructure work
whose failure modes (disk, retention, consumer leakage) are new and permanent.

## Decision

Make the turn resumable, using the pod that already outlives the orchestrator —
the agent's own — as the buffer. Three parts.

### 1. The agent holds its concluding message until it is acked

New down-message `reply_ack { ackSeq }`. The agent publishes `reply` (either
finality) and `failed` through `publishHeld`, which re-offers the *identical
envelope* — same `seq`, so a duplicate is recognizable as one — every
`AGENT_REPLY_ACK_RETRY_MS` (10s) until the orchestrator acks that `seq`, giving
up after `AGENT_REPLY_ACK_TIMEOUT_MS` (10min).

Narration (`progress`/`warning`) is deliberately not held: it is commentary,
worthless once the turn it narrated is over. A question (non-final `reply`) *is*
held — losing a question strands the conversation exactly as badly as losing an
answer — and its hold is released the moment the answer arrives, since an answer
proves the question landed.

### 2. The conversation is anchored to the run before the wait, not after

`SessionRecord.activeAgentRunAwaitingReply` distinguishes "this run owes us a
reply" from the pre-existing "this run is parked on a question". It is written
by `markAgentRunAwaitingReply` immediately after the AgentRun is created and
*before* `awaitReply` is entered.

The timing is the whole point. `InvokeServer.persistSession` runs after the
graph returns, which is fine for every outcome that has one — and useless for
this one, where the process may be SIGKILLed mid-wait. An anchor written after
the fact is an anchor that is never written.

### 3. The next turn re-attaches instead of re-delegating

`checkActiveAgentRun` already ran before retrieval to continue a parked run. It
now branches: parked on a question → publish this turn's text as a `prompt`
(unchanged); owed a reply → publish **nothing** and simply collect. Prompting
here would inject "any update?" into a working agent's conversation, and
re-delegating would do the work twice — a second branch and a second PR on a
real coding agent.

A re-attached wait is bounded at 45s rather than the full idle window, because
silence *is* diagnostic there: a working run heartbeats every 20s, a finished
one re-offers every 10s. Hearing nothing means the pod is gone, at which point
the anchor is dropped and the user is told the answer is unrecoverable — rather
than being made to wait out ten minutes to learn it.

An interrupted turn now reports a resumable pause (`result`, not `error`):
nothing failed, and "your request failed, try again" would be the third
variation on telling someone their successful run failed.

## Consequences

**An uncollected answer keeps a Job pod alive** for up to the hold timeout,
which delays that AgentRun reaching a terminal phase. That is the mechanism
working, not a leak — the hold *is* the buffer — but it makes the timeout an
operational setting (`AGENT_REPLY_ACK_TIMEOUT_MS`, `0` disables holding
entirely) rather than an internal detail. values-e2e sets 90s so a spec that
deliberately strands a reply still terminates inside its budget.

**A mixed deployment holds pointlessly.** An orchestrator too old to send
`reply_ack` never acks, so agents from this commit forward hold every concluding
message for the full timeout before exiting. Bounded and harmless to
correctness (the reply is published immediately either way), but it is why the
timeout is env-tunable and why `0` exists.

**The interrupted turn itself is still lost.** The invocation record
integration-gateway polls lives in an in-process `Map`, so the in-flight *turn*
cannot be recovered — only the answer, on the next turn. Making the turn itself
survive means durable invocation records, which this does not attempt.

**Agent-backed Tools (`runTool`) remain unresumable.** They have no session slot
to anchor a tool-launched AgentRun, the same v1 scope cut already recorded there
for non-final replies. A rollout mid-dispatch still fails that turn.

**Duplicate concluding messages are now possible on the wire.** Re-offers reuse
their original `seq` precisely so a consumer can tell a re-offer from a second
reply; anything added later that consumes the up subject must not assume
at-most-once delivery.

**JetStream is not ruled out.** If durable orchestration arrives for the
invocation records above, moving the up subject onto a stream would subsume the
hold entirely, and `AGENT_REPLY_ACK_TIMEOUT_MS=0` is the switch that retires it.
