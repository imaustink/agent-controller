# 0024. `IntegrationRoute` CRD — deterministic event→Skill/Agent/Tool dispatch

Status: accepted

## Context

`docs/integrations-gateway.md`'s GitHub Issues adapter only ever implements
the conversational path: every webhook event is normalized into a request
string and relayed into `agent-orchestrator`'s existing `POST /invoke`, which
picks a target via RAG skill retrieval. That's the right default for free
text, where intent genuinely needs inferring — but it's the wrong tool for a
trigger whose intent is already unambiguous. A specific label being applied
to a GitHub issue is exactly that: applying a label is a discrete UI action,
not a message to interpret, and the only question is "which agent handles
this," not "does this need a skill at all."

(This mechanism was originally designed around *assignment* — a GitHub issue
being assigned to the bot's own account — before discovering during rollout
that GitHub App bot users generally cannot be set as issue assignees at all
(only a small GitHub-owned allowlist, e.g. `dependabot[bot]`, gets that
special-cased), so `issues.assigned` never actually fires for a custom App.
A configurable label (`issues.labeled`) replaced it — same "unambiguous
action, not free text" reasoning, but one that actually works for any GitHub
account type. Everything below describes the label-based trigger; the CRD,
registry, and graph-bypass mechanism are unchanged from the original design.)

We considered having `integration-gateway` itself launch an `AgentRun`
directly for this case (the "one-off/FAAS path" `docs/integrations-gateway.md`
§4 describes but marks unimplemented). Rejected: the gateway has no
Kubernetes API access today (no `@kubernetes/client-node`, no RBAC), and
building a second dispatch path there would duplicate policy — which
skill/agent handles which event would live in two places (gateway code and
whatever the orchestrator's RAG considers) and lose the orchestrator's
existing session-continuity (ADR 0017), identity resolution, and
reply-posting machinery for free.

`docs/integrations-gateway.md`'s own "Open Questions" section already floated
a CRD (tentatively named `IntegrationRoute`) for exactly this — a small,
declarative event→target table, deferred until "an adapter or two exist to
validate the need." This is that adapter.

## Decision

**New CRD**, `controllers/core-controller/api/v1alpha1/integrationroute_types.go`,
following the `Skill`/`Tool` conventions (ADR 0010): `IntegrationRouteSpec`
has a `match` (`source`/`event`/`action`, e.g. `github`/`issues`/`labeled`)
and exactly one of `skillRef`/`agentRef`/`toolRef` (CEL-enforced, same pattern
as `ToolSpec`'s agentRef-vs-image split), plus a `promptTemplate` string.
`IntegrationRouteReconciler` validates the single ref resolves to a real
CR in-namespace and sets a `Ready` condition — a static-config sanity check,
not an authorization boundary, exactly like `SkillReconciler`.

**`agent-orchestrator`** already owns full CRD read/write access and the
registry+watcher pattern (`CrdSkillRegistry`, ADR 0020) other catalogs use, so
it — not the gateway — owns reading routes: `CrdIntegrationRouteRegistry`
(`src/routing/crd-integration-route-registry.ts`) lists/watches
`IntegrationRoute` CRs and exposes `match(source, event, action)` (exact
action match preferred over an action-less wildcard route).

**`/invoke`'s HTTP contract gains one optional field**, fully backward
compatible: `event: { source, event, action, ...adapter-specific fields }`.
When present and it matches an installed route, `handleInvoke` renders the
route's `promptTemplate` (a minimal dependency-free `{{field}}`
string-substitution — no templating library, deliberately not a general
rules engine per `docs/integrations-gateway.md`'s own non-goal) and sets
`forcedSkillId`/`forcedAgentId` on the graph input. No `event` field, or no
matching route, behaves exactly as before this feature existed.

**Graph bypass** (`src/agent/graph.ts`): a new `checkIntegrationRoute` node
runs right after `resolveIdentity` and before `checkPendingIdentityLink`. It
re-resolves the forced skill/agent under the caller's *current* RBAC roles
(same discipline as `checkActiveSkill`/`checkPendingIdentityLink`) and, on a
hit, routes straight to `delegateToAgent`/`loadSkillTools` — skipping RAG
retrieval entirely for this turn. A miss (ref gone, roles revoked, no
`event`/no match) is never an error; it falls through to the ordinary
identity-link/skill-continuity chain unchanged.

**`integration-gateway`** stays dumb, per the prior decision: it gains a new
`issues`/`labeled` webhook handler (`src/webhooks/github.ts`) gated on the
label applied matching a configured trigger label
(`GATEWAY_GITHUB_TRIGGER_LABEL`) — GitHub sends `issues.labeled` for every
label added, so the gateway filters to just the one that means "triage this."
On a match, it still relays through the same conversational `/invoke` call
(same session id, same identity resolution on the user who *applied the
label*, same reply-posting) — just with an `event` descriptor attached
alongside the usual fallback request text.

**Sample route**: `github`/`issues`/`labeled` → `opencode-swe-agent`, wired
as a Helm-templated `IntegrationRoute` (`charts/community-components/templates/
integrationroute-github-issue-labeled-triage.yaml`, gated by
`integrationRoutes.githubIssueLabeledTriage.enabled`), same pattern as
`skill-self-improvement.yaml`. Production's trigger label is `"ai-triage"`
(`charts/agent-controller/values-production.yaml`'s
`integrationGateway.config.githubTriggerLabel`).

## Consequences

- RAG skill retrieval remains the default and the fallback — nothing about
  ordinary conversational turns changes; `IntegrationRoute` only activates
  when a caller explicitly sends a matching `event` descriptor.
- The mechanism generalizes to future adapters (Slack, a different label,
  a cron trigger) with zero code changes to the CRD/registry/graph-bypass —
  just a new `IntegrationRoute` CR — matching the "declarative, not a rules
  engine" non-goal `docs/integrations-gateway.md` already committed to. A
  second GitHub label trigger, for example, needs only a new
  `IntegrationRoute` CR and a gateway-side label-name check (or, if the
  gateway should support multiple trigger labels without a redeploy, a
  small follow-up to make `GATEWAY_GITHUB_TRIGGER_LABEL` a set rather than
  a single string — not needed yet with only one label in use).
- `agent-orchestrator`'s ServiceAccount RBAC gains read-only
  `get;list;watch` on `integrationroutes`
  (`charts/agent-controller/charts/agent-orchestrator/templates/rbac.yaml`) —
  a small, read-only blast-radius increase, same shape as its existing
  Tool/Skill/Agent grants.
- The gateway remains free of any Kubernetes API access — routing stays
  entirely the orchestrator's responsibility, keeping the gateway's blast
  radius unchanged.
