# Proposal: Trigger agents via issue/PR comments ("tag an agent")

Status: **proposed** (tracking: [#159](https://github.com/imaustink/agent-controller/issues/159))

> This is a *proposal*, not an accepted decision — it is not an ADR. It exists to
> frame the problem and options for discussion on #159. Once a direction is
> agreed, the chosen design should graduate into an ADR under `docs/adr/`.

## Problem

We want to **trigger agents by commenting on a GitHub issue/PR** — "tag" an
agent in a thread (`@some-agent do X`, or `/agent <name> …`) and have it run,
with follow-up comments continuing the same conversation. Today this does not
work, and there is no way to address ("tag") a specific agent from a comment.

## Current behavior (why it doesn't work today)

- **Comments are a deliberate no-op.** `parseGithubEvent`
  (`apps/integration-gateway/src/webhooks/github.ts`) returns an actionable
  event **only** for `issues.labeled` and `pull_request.labeled`.
  `issue_comment.created` maps straight to `{ kind: "ignored" }` before any
  identity resolution or orchestrator call — see `docs/integrations-gateway.md`
  §"Implementation status": *"Opening an issue, or commenting on one, never
  causes the agent to run."*
- **No way to address a specific agent from text.** Deterministic dispatch goes
  through the `IntegrationRoute` CRD (ADR 0024), whose `spec.match` keys on
  `{ source, event, action, labelName }` only
  (`apps/agent-orchestrator/src/routing/crd-integration-route-registry.ts`).
  There is no `mention`/`command` selector and no mapping from an `@handle` to
  an `Agent` CR. Free text otherwise falls back to RAG skill retrieval, which
  *infers* a skill rather than letting a user *pick* an agent.
- **GitHub-App accounts generally can't be assignees**, and "assign the bot" was
  already rejected during rollout for that reason (ADR 0024) — a label replaced
  it. Plain `@mention` of an App account shares that class of limitation, so
  "tag an agent" needs a real design, not just enabling a webhook.
- **The gap is already acknowledged.** Per #81 / ADR 0025, the only way to
  continue a triage conversation today is the server-rendered session page
  (`POST /sessions/:token/prompts`), precisely *"since unlabeled
  `issue_comment` events are a no-op."*

## Building blocks (needed by every option)

1. **Transport** — subscribe to and parse `issue_comment.created` (and likely
   `pull_request_review_comment.created`) in `parseGithubEvent` /
   `handleGithubWebhook`, emitting a normalized event carrying the comment body
   and id.
2. **Addressing ("tagging")** — a grammar to name an agent from the comment
   text, plus a resolver from that name → an `Agent` CR / route.
3. **Cross-cutting safety** — loop prevention, identity gating, re-trigger
   idempotency, and a low-noise ack/status UX (see below).

## Options

All assume building block #1; they differ in **how you address an agent (#2)**.

### Option A — Slash-command grammar → `IntegrationRoute` (recommended)

A constrained command posted as a comment, e.g. `/agent <name> <request>` (or
verbs like `/triage`, `/review`). Add `event: "issue_comment"` (optionally an
explicit `command`) to `IntegrationRoute.spec.match`, so a command maps to a
target exactly the way `labelName` does today. The text after the command feeds
the `promptTemplate` (`renderPromptTemplate` already supports `{{body}}`,
`{{senderLogin}}`, …; add `{{commentBody}}`).

- **Pros:** deterministic and self-documenting (`/help`), reuses the existing
  CRD dispatch + specificity rules, matches ADR 0024's "unambiguous discrete
  action, not free text" philosophy, trivial to parse → few false triggers.
- **Cons:** less "natural" than an `@mention`; users must learn the commands.

### Option B — `@mention` handle → `Agent` resolver

Give each `Agent` CR a mention handle (annotation
`controller-agent.dev/mention`, or reuse `metadata.name`). A comment containing
a known handle resolves **directly** to that `AgentRef`, bypassing label
matching; the rest of the comment is the request.

- **Pros:** closest to the literal "tag an agent" ask; discoverable handle
  catalog; composes with A (A = transport, B = resolver).
- **Cons:** needs a handle registry + collision rules; freeform parsing is more
  error-prone; must avoid triggering on incidental mentions.

### Option C — Dedicated bot `@mention` + reaction-based status

Make the GitHub App mentionable; treat any comment `@`-mentioning the bot as a
trigger (routed by RAG, or by a handle after the mention). Acknowledge with a
**reaction** (👀 → 🚀 → ✅) instead of a "starting work" comment, and use
"reaction cleared on completion" as the re-trigger gesture — the comment
analogue of today's trigger-label removal in `relayAndReply`'s `finally`.

- **Pros:** most natural UX; reactions are low-noise and give a clean
  idempotency/ack story.
- **Cons:** App-mention semantics/limitations; RAG routing can't *pick* a
  specific agent without B.

### Option D (baseline) — Session-page-only, no comment trigger

Keep comments a no-op and make the existing session page the canonical
follow-up channel instead.

- **Pros:** zero new webhook surface / loop risk.
- **Cons:** does not satisfy the request; listed only as the do-nothing baseline.

## Recommendation

Ship **A** as the foundation (deterministic, reuses the CRD), layer **B** so
`/agent <name>` and `@<name>` both resolve to the same `Agent`, and use **C**'s
reaction-based ack as the status UX. Reuse the existing per-issue session id
(`github:<owner>/<repo>#<number>`) so comment threads become multi-turn
sessions.

## Reviewer assessment (2026-07-30)

> Added during review of #160. This section is a reviewer's opinion on the path
> forward, kept in-repo alongside the proposal per the PR's own intent. It does
> not change the proposal's framing above; it endorses a direction, refines the
> sequencing, and flags gaps to resolve before the design graduates to an ADR.

**Verdict: endorse the recommendation — ship A first, layer B, adopt C's
reaction ack — but with the refinements below.** The problem statement and every
code claim above check out against the current tree (`parseGithubEvent` ignores
`issue_comment.created`; `IntegrationRoute.match` keys only on
`{source,event,action,labelName}`; ADR 0024 rejected bot-as-assignee; label
removal happens in `relayAndReply`'s `finally`).

### Why A is the right foundation

Option A is the only option that is *independently shippable* and satisfies the
bulk of the ask with the smallest, most reviewable diff. It extends the existing
deterministic CRD dispatch rather than introducing a parallel routing path, so
it inherits the specificity ordering, hot-reload, and test surface already in
`crd-integration-route-registry.ts`. It also aligns with ADR 0024's explicit
"unambiguous discrete action, not free text" philosophy — a `/agent` prefix is a
discrete action, whereas free-text mention detection is exactly the ambiguity
that ADR rejected. Everything else (B, C) is a refinement layered on A, so A is
the correct first merge regardless of how far the feature ultimately goes.

### Refinements to the recommendation

1. **Take C's reaction ack; drop C's mention-as-RAG-*routing*.** The reaction
   ack (👀 → ✅) is low-risk, genuinely better UX, and worth adopting in Phase 1.
   But C's *routing* half — "make the App mentionable, route by RAG" — cannot
   pick a specific agent (RAG infers a skill, it does not let a user choose),
   which is the literal ask. That job belongs to B. So C contributes an ack
   mechanism, not a second routing mechanism; treating it as routing just
   duplicates B behind uncertain GitHub-App-mention semantics.

2. **Correct the live-follow-up framing (it is stale).** The doc leans on the
   session page as "the only way to continue a triage conversation today"
   (ADR 0025) and Option D proposes making it "the canonical follow-up channel."
   The current code has moved past that: `relayAndReply` **deliberately never
   posts the session-page URL** — the only link surfaced up front is a **Claude
   Code Remote Control** link (`onRemoteControlUrl`), and ADR 0026 makes the live
   opencode session over the NATS tunnel the real interaction channel. So the
   multi-turn story for comment threads should reuse the per-issue session id
   **plus** the Remote Control / NATS live session (ADR 0026), not the
   server-rendered session page. This also makes D weaker than stated: the
   do-nothing baseline is "keep the Remote Control link," not "invest in the
   session page."

3. **Idempotency needs a *persistent, replica-safe* dedupe store — name it.**
   "Dedupe on the comment id" is right, but an in-memory set fails across gateway
   restarts and across replicas, which is exactly when GitHub redelivers. The
   infra already exists — `SessionPageStore` is Redis-backed (`ioredis`) — so
   Phase 1 should record processed comment ids there (or a sibling keyspace) with
   a TTL, not in process memory. Call this out explicitly so it is not
   discovered in production.

4. **Loop prevention: tighten beyond `senderIsBot` + prefix.** Also (a) require
   the command/mention at the **start of a line** so a quoted echo of a prior
   `/agent` in a reply does not re-trigger; (b) decide the scope of `action:
   "edited"` comments (default: ignore edits) and `pull_request_review_comment`
   vs `issue_comment` — they are distinct events and Phase 1 should pick one
   explicitly rather than accidentally handling both.

5. **Add an authorization acceptance criterion.** "Run as the commenter via
   `identityResolver.resolve`" is correct, but the criteria are silent on the
   unlinked/unauthorized commenter. That path should reuse the label flow's
   park-and-link behavior (not a silent no-op that looks broken to the user).
   Add: *"A commenter without a linked identity gets the same link/park flow the
   label paths use, not silence."*

### Suggested build order

- **Phase 0 (this PR):** land the proposal. Graduate the chosen direction to an
  ADR under `docs/adr/` once #159 agrees (the proposal already commits to this).
- **Phase 1 — Option A, end to end and independently useful:**
  `issue_comment.created` transport in `parseGithubEvent`/`handleGithubWebhook`;
  `event: "issue_comment"` (+ optional `command`) in `IntegrationRoute.match`;
  `{{commentBody}}` in `renderPromptTemplate`; Redis-backed comment-id dedupe;
  `senderIsBot` + line-start-prefix loop guard; reaction ack from C.
- **Phase 2 — Option B:** Agent handle resolver (annotation
  `controller-agent.dev/mention` or `metadata.name`) so `/agent <name>` resolves
  to a specific `Agent`; unify `@<name>` into the *same* resolver so the two
  spellings never diverge.
- **Phase 3 — polish:** `pull_request_review_comment` support if wanted;
  multi-turn threads via the existing session id + Remote Control (ADR 0026).

This ordering means each phase merges something users can actually use, keeps the
first diff small enough to review against ADR 0024, and defers the two genuinely
hard, uncertain pieces (freeform handle parsing, App-mention semantics) until
after the deterministic path is proven.

## Cross-cutting concerns (any option)

- **Loop prevention:** keep the `senderIsBot` drop so the agent can't trigger on
  its own reply comments; also require the explicit command/mention prefix so
  ordinary chatter never triggers.
- **Identity/authorization:** run as the commenter — reuse
  `identityResolver.resolve(senderLogin, senderIsBot, …)` as the label paths do.
- **Idempotency / re-trigger:** no label to remove after a run; dedupe on the
  comment id so a redelivered webhook doesn't double-run. "Post another command"
  is the re-trigger gesture (C adds a reaction ack).
- **Fast ack:** keep the 202-then-work pattern (GitHub's webhook timeout is
  short).

## Acceptance criteria

- [ ] Commenting `/agent <name> <request>` (and/or `@<name> <request>`) on an
      issue or PR triggers the named agent, running as the commenter.
- [ ] Bot-authored comments never self-trigger; non-command comments are a
      no-op.
- [ ] Follow-up comments continue the same session as the issue/PR.
- [ ] Redelivered/duplicate webhooks don't double-run (comment-id dedupe).
- [ ] `docs/integrations-gateway.md` updated to describe the comment trigger.
