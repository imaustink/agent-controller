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
