# Event Integrations & FAAS Gateway (design proposal)

> **Status:** largely superseded by
> [ADR 0048](adr/0048-generic-event-triggers.md): ingestion is generic,
> declared by **`EventSource`** CRs (verified webhooks of any shape, or cron
> schedules), and dispatch by **`EventTrigger`** CRs (CEL match → orchestrator
> turn, forced Skill, Agent, or one-off Tool — the FAAS path of §4), with the
> contract in [docs/event-triggers.md](event-triggers.md). See
> "Implementation status" at the end of this document. The email channel and
> non-GitHub reply adapters remain unimplemented. This document was originally
> written to the same standard as [orchestrator.md](orchestrator.md) and
> cross-referenced from [README.md](../README.md). It assumes familiarity
> with [orchestrator.md](orchestrator.md), [messaging.md](messaging.md), and
> [security.md](security.md); it does not repeat their content.

## Problem

Every consumer of this system today is a synchronous HTTP caller talking
directly to `agent-orchestrator`'s invoke API or OpenAI-compatible facade
(ADR 0006, ADR 0007). There is no supported way for **external events** —
an inbound email, a Slack message/mention, a CI job webhook, a scheduled
trigger — to reach a skill, tool, or agent. Separately, every existing entry
point goes through skill retrieval (ADR 0008): there is no path to invoke a
known tool or agent **directly by id**, the way a FAAS platform's
`POST /functions/:name/invoke` would. This proposal covers both, because
they share almost all of their plumbing:

1. **Event-driven integrations** — adapters that turn email/Slack/webhook/job
   events into agent input, and turn agent output back into a reply on the
   originating channel (a Slack thread reply, an email reply, a job status
   callback).
2. **A FAAS-style gateway** — a direct, catalog-driven invocation surface
   (`Tool`/`Agent` CR by id) for one-off tasks that don't need RAG skill
   selection at all, reusing the same `ToolRun`/`AgentRun` machinery
   (ADR 0010) that already exists.

Both conversational (multi-turn, session-scoped) and one-off (single request,
no session) interactions must be supported, and the adapter set must be
extensible without touching the orchestrator's reasoning graph.

## Goals

- Reuse the existing catalog (`Tool`/`Skill`/`Agent` CRs), launch mechanism
  (`ToolRun`/`AgentRun` + core-controller), and event protocol
  (`@controller-agent/messaging`) — this is new **entry points**, not a new
  execution model.
- One new component owns *all* channel-specific concerns (auth verification,
  payload parsing, reply formatting) so `agent-orchestrator`'s graph stays
  channel-agnostic, exactly as ADR 0007's chat facade keeps the graph
  transport-agnostic today.
- Support both interaction shapes from day one:
  - **Conversational**: an inbound event belongs to an ongoing thread
    (Slack thread ts, email `In-Reply-To`/`References`, chat session) and
    should resume that conversation's active skill (ADR 0012) and
    continuation state (ADR 0017).
  - **One-off / FAAS**: an inbound event (job webhook, scheduled trigger, a
    Slack slash-command-style invocation) names a specific tool or agent by
    id and skips skill retrieval entirely — closer to `POST /invoke` than to
    `/v1/chat/completions`.
- New channels are additive: adding Discord or MS Teams should mean adding an
  adapter, not modifying the orchestrator.
- Preserve the existing security posture: identity resolution stays
  fail-closed, RBAC filtering is unchanged, and every new inbound surface
  gets the same "untrusted external input" treatment `security.md` already
  applies to scraped content and callback bodies.

## Non-goals (for this proposal)

- Redesigning skill retrieval, RBAC, or the `ToolRun`/`AgentRun` execution
  model — all reused as-is.
- Picking the specific Slack/email SDKs — deferred to implementation.
- A general-purpose no-code workflow builder — routing config here is
  declarative but intentionally small (trigger → skill/tool/agent), not a
  full rules engine.

## Proposed architecture

```mermaid
graph TD
    Email[Inbound email\ne.g. SES/SNS, IMAP idle]
    Slack[Slack Events API\nmessage / mention / slash command]
    Job[CI / job webhook\ne.g. GitHub Actions, Argo]
    FAAS[Direct FAAS call\nPOST /fn/:toolOrAgentId]

    subgraph GW["apps/integration-gateway (new, long-lived)"]
        Verify[Per-adapter signature/\nauth verification]
        Normalize[Adapters normalize to\nInboundEvent]
        Router[Router: conversational vs. one-off,\nresolve identity, resolve session id]
        Reply[Per-adapter reply formatter\n+ delivery]
    end

    Orchestrator[agent-orchestrator\n/invoke or /v1/chat/completions]
    ToolRunCR[ToolRun CR]
    AgentRunCR[AgentRun CR]
    SessionStore[(SessionStore\nRedis/in-memory)]

    Email --> Verify --> Normalize --> Router
    Slack --> Verify
    Job --> Verify
    FAAS --> Verify

    Router -->|conversational| Orchestrator
    Router -->|one-off, tool id known| ToolRunCR
    Router -->|one-off, agent id known| AgentRunCR
    Orchestrator -.->|session_id| SessionStore
    Orchestrator -->|result| Reply
    ToolRunCR -->|callback result| Reply
    AgentRunCR -->|callback result| Reply
    Reply --> Email
    Reply --> Slack
    Reply --> Job
    Reply --> FAAS
```

### 1. `apps/integration-gateway` — a new long-lived service

A new app, following the existing convention (own image, own hardened run
contract, no direct imports from `agent-orchestrator` or any `tools/*`/
`apps/*` sibling — only from `packages/*`). It is the **only** thing that
knows about Slack/email/webhook specifics; `agent-orchestrator`'s graph is
never modified to accommodate a new channel.

Responsibilities, mirrored on the existing chat-facade split (ADR 0007) so
this is an additive sibling, not a rework:

- Terminate each channel's inbound transport (Slack Events API POST, an
  inbound-email webhook from an email-relay provider, a generic job/CI
  webhook, a direct FAAS-style HTTP call) behind **per-adapter signature
  verification** — Slack's signing secret, the email relay's shared secret,
  a bearer token / HMAC for job webhooks and the FAAS path. Unverified
  requests are rejected before any payload is parsed, same posture as
  `CallbackSink`'s HMAC check (messaging.md).
- Normalize each verified payload into one shared `InboundEvent` shape (see
  below) — the only thing routing/downstream code depends on.
- Decide **conversational vs. one-off** (see next section) and either
  forward to `agent-orchestrator`'s existing invoke/chat surface, or create a
  `ToolRun`/`AgentRun` directly.
- Receive the eventual result (via the existing async invoke poll, or via
  the existing messaging callback for direct `ToolRun`/`AgentRun`s) and
  format+deliver a reply on the originating channel (Slack thread reply,
  email reply, job-status comment/webhook, FAAS response body).

### 2. `InboundEvent` — the shared normalized shape

A small package-level type (candidate: a new `@controller-agent/messaging`
addition, or a sibling package if it grows independent versioning needs —
see [Open questions](#open-questions)) that every adapter produces and every
router/reply path consumes:

- `channel`: `"email" | "slack" | "job" | "faas" | ...` (extensible
  discriminator, one new adapter = one new value, no changes to existing
  ones).
- `externalThreadId`: adapter-defined conversation key (Slack thread ts +
  channel id, email `Message-Id`/`References` chain, job run id) —
  `undefined` for a genuinely one-off event.
- `callerIdentity`: adapter-resolved identity input (Slack user id + team,
  email `From`, job webhook's service identity/token subject) — handed to
  the *same* `resolveIdentity` RBAC step the orchestrator already runs
  (docs/orchestrator.md#3), never trusted directly for authorization.
  Identity resolution stays fail-closed exactly as it is today: an adapter
  that cannot map its caller to a known identity produces zero candidate
  tools, not an unfiltered one.
- `text`: the natural-language payload (email body, Slack message text, a
  FAAS call's freeform `input.text`), always treated as untrusted content
  per `security.md`, same as scraped content.
- `target` (optional): an explicit `{ kind: "tool" | "agent", id, args }` —
  present when the event already names what to run (a job webhook wired to
  a specific tool, a FAAS call to `/fn/:id`, a Slack slash command bound to
  one tool). When present, this **is** the one-off/FAAS path and skill
  retrieval is skipped entirely.
- `replyRef`: adapter-specific opaque data needed to deliver the eventual
  reply (Slack channel+thread, email `Message-Id` to reply against, job
  webhook callback URL, FAAS caller's poll id) — never inspected outside
  that adapter's own reply formatter.

### 3. Conversational path — reuses the orchestrator unchanged

When `target` is absent, the gateway treats the event exactly like an
Open WebUI chat turn (ADR 0007, ADR 0012):

- `externalThreadId` maps 1:1 onto the existing `session_id` concept — the
  gateway is simply another **producer** of a session id, alongside
  `X-OpenWebUI-Chat-Id`. No changes needed to `SessionStore`,
  `checkActiveAgentRun`, or continuation tokens (ADR 0017); a Slack thread or
  an email chain gets the same session-scoped active-skill and continuation
  behavior a chat client's conversation already gets.
- The gateway calls `agent-orchestrator`'s existing `POST /invoke` (or the
  chat-completions facade, if streaming narration is useful for a given
  channel) with `{ request: text, session_id: externalThreadId }` and the
  resolved bearer/identity forwarded the same way any other caller's is.
- On the async result (poll or a small internal notification, see
  [Open questions](#open-questions) on eliminating polling), the gateway's
  reply formatter for that channel turns the result into a Slack message,
  an email reply, etc.

This path adds **zero** new concepts to `agent-orchestrator` — it is a new
caller of an interface that already exists.

**GitHub Issues is the first implemented adapter for this path** — see
[Implementation status](#implementation-status).

### 4. One-off / FAAS path — direct `ToolRun`/`AgentRun`, skips retrieval

When `target` is present, the gateway skips the graph's retrieval/selection
steps entirely and creates the `ToolRun` or `AgentRun` CR directly — the same
CR, the same core-controller reconciliation, the same messaging callback
protocol a skill-selected tool call already uses (docs/orchestrator.md#4).
Concretely this is a small, focused component in the gateway (not a
dependency on `agent-orchestrator`'s process) that:

- Re-validates the caller's resolved roles against the target `Tool`/`Agent`
  CR's `allowedRoles` (the same defense-in-depth check already done at
  launch time today) — a job webhook or FAAS caller naming a tool id
  directly must still pass this check; naming it explicitly is not an
  authorization bypass.
- Creates the CR via `@kubernetes/client-node` exactly as
  `ContainerToolLauncher`/`ToolRunLauncher` does, with the gateway's own
  callback URL so the result routes back to the adapter's reply formatter
  instead of to `agent-orchestrator`.
- Returns the same async accept/poll contract as `POST /invoke` (ADR 0006)
  for the `faas` channel specifically (`POST /fn/:id` → `202 { id }`,
  `GET /fn/:id` polls) — this **is** the "FAAS gateway" from the problem
  statement: a thin, catalog-driven direct-invoke surface with no
  skill/LLM step in between, layered on infrastructure that already exists
  rather than a parallel implementation.

This reuses 100% of the hardened Job contract (`security.md`) and the
existing RBAC/launch code path; the only new code is "look up a CR by id and
launch it directly" instead of "an LLM chose which CR to launch." **Not
implemented** — see [Implementation status](#implementation-status).

### 5. Reply delivery

Symmetric to inbound: each adapter owns turning a terminal result (`succeeded`
`{ result }` / `failed { code, message }` from messaging.md's protocol) into
a channel-appropriate reply and owns its own outbound auth (Slack bot token,
outbound SMTP/relay credentials, job webhook's own callback contract). Same
treatment as `CallbackSink`'s outbound constraints (messaging.md): reply
targets come only from the adapter's own trusted config or the original
inbound event's `replyRef`, never from tool/agent output content, to avoid
turning a reply path into a new SSRF/exfil surface.

## What's reused vs. new

| Concern | Reused as-is | New |
| ------- | ------------ | --- |
| Tool/Skill/Agent catalog, RBAC filtering | `Tool`/`Skill`/`Agent` CRs, `CrdToolRegistry`, `resolveIdentity` | — |
| Skill retrieval, action planning | LangGraph graph, `VectorStore` | — |
| Job launching, hardening | `ToolRun`/`AgentRun` + core-controller | — |
| Container ↔ parent event protocol | `@controller-agent/messaging` (`Sink`, `CallbackSink`, `EventSchema`) | — |
| Session continuity, continuation tokens | `SessionStore`, ADR 0012, ADR 0017 mechanism | New producer of `session_id` (external thread id) |
| Consumer-facing HTTP pattern | ADR 0006 async accept/poll shape | Reused for the `faas` channel's `POST /fn/:id` |
| Channel-specific auth/parsing/reply | — | Per-adapter code in `apps/integration-gateway` |
| Direct-by-id tool/agent invocation | `ToolRun`/`AgentRun` launch mechanics | New "launch by id, skip retrieval" component |

## Security considerations (extends `security.md` and `orchestrator.md`)

- **Every inbound adapter is a new untrusted-input boundary.** Signature/
  auth verification happens before parsing, and a failed/missing signature
  is rejected outright — no adapter should have a "trust by default" mode.
- **Identity resolution stays fail-closed per channel.** An adapter that
  cannot confidently map its caller to a known identity must resolve to "no
  identity" (zero candidate tools), never a default/broad identity —
  consistent with the existing RBAC posture (docs/orchestrator.md#3).
- **`target`-based direct invocation is not an authorization bypass.** Naming
  a tool/agent id directly (job webhook, FAAS call) still goes through the
  same `allowedRoles` check a RAG-selected call goes through; the only thing
  skipped is retrieval/ranking, never RBAC.
- **External thread ids are guessable/spoofable**, same class of risk ADR
  0012 already documents for `X-OpenWebUI-Chat-Id`: sessions stay bound to
  the *resolved identity*, not the thread id, so a guessed Slack thread ts or
  forged `In-Reply-To` can't pull another caller's session.
  Continuation-token flows (ADR 0017) already exclude marker content from
  any LLM-visible transcript — the gateway must not reintroduce it into a
  reply.
- **Reply targets are adapter-config-derived, never content-derived** — see
  §5 above; mirrors the existing `CallbackSink` SSRF guard.
- **Email is the highest-risk channel** for prompt injection (arbitrary
  senders, arbitrary body content, potential HTML/attachments) — treat email
  body content with at least the scrutiny `security.md` gives scraped web
  content, and consider stripping/ignoring attachments in a first iteration
  rather than processing them.
- **Job/CI webhooks often carry elevated implicit trust** (they come from
  infrastructure, not end users) — resist the temptation to skip
  verification/RBAC for this adapter specifically; treat it identically to
  the others.

## Extensibility model

- New channel = new adapter module implementing `parse(rawRequest) →
  InboundEvent` and `reply(result, replyRef) → void`, registered in the
  gateway's adapter table. No changes to routing, `agent-orchestrator`, or
  other adapters.
- New "one-off" trigger shapes (e.g. a cron-style scheduled trigger with no
  inbound HTTP request at all) fit the same `InboundEvent` shape with a
  synthetic adapter that constructs one on a timer instead of parsing a
  request — router/launch code is unchanged.
- Routing configuration (which source/event maps to which skill, tool, or
  agent) is `EventSource` + `EventTrigger` CRs (ADR 0048), so operators
  manage it the same `kubectl apply` way they already manage
  `Tool`/`Skill`/`Agent` (see README's "why CRDs" table). A new webhook source
  or cron schedule is a new `EventSource`, not gateway code. See
  [Implementation status](#implementation-status) for what's built.

## Open questions

- **Polling vs. push for gateway → adapter results.** `POST /invoke`'s async
  accept/poll (ADR 0006) fits a chat client polling its own request, but a
  gateway proxying for Slack/email doesn't want to poll indefinitely on a
  potentially slow tool. Likely answer: the gateway registers its own
  callback URL directly with the `ToolRun`/`AgentRun` (one-off path) or with
  `agent-orchestrator`'s equivalent for the conversational path — needs a
  small extension point on the invoke API to accept a callback URL
  *from the gateway itself* (a trusted first-party caller, not the
  caller-supplied-webhook SSRF risk ADR 0006 rejected for end users). The
  GitHub Issues adapter (below) works around this today with bounded
  polling; that's a stand-in, not the intended long-term answer.
- **Where `InboundEvent` and adapter interfaces live** — a new
  `packages/integrations` shared package (parse/reply contracts only, no
  channel SDKs) vs. keeping them inside `apps/integration-gateway` until a
  second consumer needs them. Given `packages/*` is meant for logic reused
  across workspace members (per repo conventions) and today there's exactly
  one consumer, starting inside the app and extracting later is likely
  lower risk.
- **Rate limiting / abuse controls per channel** — email and Slack are
  effectively open to anyone who can reach the webhook URL or DM the bot;
  needs a throttling story before general availability, separate from RBAC
  (RBAC governs *what* an identified caller can do, not *how often*).
- **Multi-tenant credential storage for outbound adapters** (Slack bot
  tokens per workspace, SMTP/relay credentials, per-tenant FAAS API keys) —
  likely k8s Secrets per adapter instance, consistent with existing secret
  handling (`security.md`), but the exact shape (one gateway per tenant vs.
  one gateway routing to many tenant credentials) is undecided.
- **Attachment/binary handling for email and Slack** — ties into the
  existing `ArtifactRef`/object-store roadmap item in `messaging.md`; likely
  the same mechanism, not a parallel one.

## Suggested phasing

1. **FAAS path first** (`apps/integration-gateway` with only the `faas`
   adapter): validates the direct-by-id `ToolRun`/`AgentRun` launch
   component and the async accept/poll extension in isolation, with no new
   external-trust surface (caller is already an authenticated API client).
   Built later as `EventTrigger.target.toolRef` (ADR 0048) — the GitHub
   Issues adapter was prioritized first since it exercised the conversational
   path end-to-end.
2. **One adapter for the conversational path.** Implemented for **GitHub
   Issues** rather than Slack (see [Implementation
   status](#implementation-status)) — validates the `InboundEvent`/
   `SessionStore` integration end to end via a different, equally
   well-documented webhook + signature-verification API.
3. **Email adapter**: highest-risk channel, built once the injection/
   untrusted-content handling patterns are proven out.
4. **Job/CI webhook adapter.** Subsumed by generic `EventSource`s (ADR 0048):
   a CI notifier is a `bearer` or `hmacSha256` webhook source, and the shipped
   `ci-failure-skill` example trigger shows the shape (see [Implementation
   status](#implementation-status)).

Each phase should land as its own ADR once concrete, per this repo's existing
convention (see [docs/adr/](adr/)).

## Implementation status

**Implemented:** [apps/integration-gateway](../apps/integration-gateway) as a
**generic event ingress** driven by two CRDs
([ADR 0048](adr/0048-generic-event-triggers.md); the authoritative contract is
[docs/event-triggers.md](event-triggers.md); field reference in
[crds.md](crds.md#eventsource)). Nothing about any one source or flow is
hardcoded in the gateway any more.

- **`EventSource` — how events arrive.** The gateway watches the EventSources in
  its namespace (`CRD_NAMESPACE`/`CRD_GROUP`/`CRD_VERSION`) and serves each
  webhook source at `POST /webhooks/<name>`, verifying the raw body **before**
  parsing with the source's scheme (`hmacSha256`, `slackV0` incl. Slack's
  `url_verification` handshake, or `bearer`) against the Secret its
  `secretRef` names, read through the k8s API. Unknown source → `404`, failed
  verification → `401`, otherwise `202`. A `cron` source is ticked by a
  core-controller-owned CronJob at `POST /events/<name>/tick`, authenticated
  as that source's own ServiceAccount (`eventsource-<name>`, a projected token
  verified against the cluster's issuer keys). Either way the gateway builds one normalized envelope
  (`source, kind, id, time, headers, body, sender, repository`) and relays it as
  `POST /invoke { event }`; it no longer filters by event type or label.
- **Who caused it.** A source's optional `sender` block extracts a login with
  CEL and verifies it with the GitHub provider (`GithubTeamMembershipResolver`
  via `GATEWAY_GITHUB_TEAM_ROLES`, `GithubCollaboratorPermissionResolver` via
  `GATEWAY_GITHUB_COLLABORATOR_ROLES`, the static `GATEWAY_GITHUB_IDENTITIES`
  fallback). An unverified login is never forwarded; bot senders are dropped by
  default, so an agent cannot label its own issue/PR to re-trigger itself. A
  source without `sender` runs as the gateway's service identity.
- **`EventTrigger` — what an event dispatches.** The orchestrator (both
  engines) matches every trigger's `match.cel` against the envelope; the winner
  binds CEL `params`, renders its `promptTemplate`/`sessionKey`, and runs its
  `target`: an ordinary conversational turn (`orchestrator: {}`), a forced
  `skillRef`, an `agentRef`, or a one-off `toolRef` — the FAAS/direct-invoke
  path of §4, now built. **No match is a clean no-op** (`200 ignored`), never a
  RAG fallback over free text. `target.readOnly: true` is the deterministic
  write gate, carried onto every `AgentRun`/`ToolRun` (`AGENT_READ_ONLY`), not a
  prompt sentinel.
- **Replies are declarative.** The orchestrator returns the trigger's rendered
  `reply`, and the gateway runs it: `reply.github` posts an `ack` comment
  (+ a session-page link when `GATEWAY_PUBLIC_URL` is set), the turn's
  `result`, and removes `removeLabel` when the run ends on every outcome —
  through the durable pending-action store, so a crash mid-run still clears the
  label (`label-reconciler.ts`). `reply.http` POSTs the outcome to a literal,
  never-templated URL, optionally HMAC-signed.
- **The `ai-triage` / `ai-review` flows are four example CRs** in
  `examples/event-triggers/` (`eventtrigger-github-{issue,pr}-{triage,review}.yaml`;
  production installs copies against `claude-code-swe-agent` through the
  agent-controller chart's `extraManifests`): each matches
  `headers["x-github-event"]`, `body.action == "labeled"` and its label in
  CEL; the two review triggers set `readOnly: true`. Triage on an issue opens a
  PR; triage on a PR addresses its feedback, pushes, and syncs with base; review
  on either posts a review and changes nothing (PR reviews put a one-click
  `suggestion` block, or a collapsible AI-agent prompt, in each
  change-requesting inline comment instead of opening follow-up issues). Session
  id stays `github:<owner>/<repo>#<number>` (`sessionKey`), one session per
  issue/PR. Further examples ship disabled: Slack mention → orchestrator turn,
  CI failure → forced Skill, generic HMAC → `web-fetch` Tool, and a nightly
  cron → read-only stale-work sweep.
- **Session page (issue #81).** The ack's link points at a minimal
  server-rendered page (`GET /sessions/:token`, `SessionPageStore`) showing the
  session's turn history, where a caller can `POST /sessions/:token/prompts` to
  continue it. `token` is a 256-bit bearer capability; unset
  `GATEWAY_PUBLIC_URL` disables the feature entirely. Redis-backed when
  `SESSION_PAGE_REDIS_URL` (or the identity-link Redis) is set, in-memory
  otherwise.
- Result delivery is **polling** `GET /invoke/:id`, not push — the "Polling
  vs. push" open question above is still worked around with a bounded poll
  timeout.
- `@controller-agent/github-app-auth` is shared with the SWE agents for GitHub
  App JWT signing / installation-token minting (ADR 0018).

**Not implemented:** reply adapters other than `github` and `http` (a Slack
event can trigger a turn, but its answer is not posted back to Slack), the
email channel, and `sender` providers other than `github`.

## Related

- [orchestrator.md](orchestrator.md) — the reasoning loop and catalog this
  proposal is a new set of entry points into.
- [messaging.md](messaging.md) — the event protocol and callback security
  model reused for gateway ↔ Job/agent communication.
- [security.md](security.md) — the threat model every new adapter extends.
- [docs/adr/0006](adr/0006-async-http-invoke-interface.md),
  [0007](adr/0007-openai-compatible-chat-facade.md) — the existing
  consumer-facing interfaces this proposal builds on rather than replaces.
- [docs/adr/0012](adr/0012-session-scoped-skill-lifecycle.md),
  [0017](adr/0017-continuation-tokens-via-session-store.md) — the session/
  continuation mechanisms the conversational path reuses unchanged.
- [docs/adr/0018](adr/0018-github-app-auth-fallback.md) — the GitHub App
  auth mechanism `@controller-agent/github-app-auth` shares between
  `apps/opencode-swe-agent` and `apps/integration-gateway`.
