# 0049. Agent identity is a declared mode: `agent`, `delegated`, or `hybrid`, overridable per EventTrigger

Date: 2026-11-11

## Status

Proposed. Builds on [0041](0041-delegated-read-write-token-split.md) (read as
the user, write as the App), [0042](0042-repository-read-gate.md) (repository
read gate), [0030](0030-authorization-preflight-outside-the-llm.md) /
[0031](0031-principal-establishing-account-link.md) (authorization pre-flight,
principals), [0046](0046-connections-page.md) (Connections page) and
[0048](0048-generic-event-triggers.md) (EventSource / EventTrigger).

## Context

Nothing names the identity a subagent acts as. Today it falls out of five
separate settings:

| Input | Where | Effect |
| --- | --- | --- |
| `github` ∈ `Agent.spec.identityProviders` | CRD | resolves a per-user `GITHUB_TOKEN` and switches on the Temporal read gate |
| `GITHUB_IDENTITY_DELEGATION=true` | Helm → agent env | turns on 0041's read/write split inside the agent image |
| whether a `GITHUB_TOKEN` is present | agent image `isDelegating()` | decides delegation by *inference* |
| `identity.perUser` | identity resolver | Go engine skips `github` for shared subjects; the TS engine does not |
| `EventTrigger.target.readOnly` | CRD | drops `github` and write creds |

So `hybrid` exists only as an emergent property of the SWE images. Pure
`agent` exists only as "forgot to declare `github`". Pure `delegated`, where
writes also run as the human, does not exist. An operator can't tell from an
Agent CR which identity it runs as.

On webhooks it's worse. integration-gateway verifies the sender
(`EventSource.spec.sender`), then authenticates to `/invoke` as its own
service subject. The verified login rides along in the signed
`x-gateway-user-assertion` and reaches the sender's **Claude** credentials via
the `github:<login>` principal. But the sender's per-user `GITHUB_TOKEN` is
keyed by their raw `openwebui:<id>` subject. Nothing maps a GitHub account back
to that subject, so a webhook turn can never act as its sender.

## Decision

### 1. `Agent.spec.defaultIdentity`

```yaml
spec:
  defaultIdentity: hybrid               # agent | delegated | hybrid
  allowedIdentities: [hybrid, agent]    # optional; which overrides a trigger may pick
  identityProviders: [github, claude-remote]
```

| Mode | Reads | Writes | Needs caller's provider link | Read gate (0042) |
| --- | --- | --- | --- | --- |
| `agent` | agent credential (App token) | agent credential | no | none. Authorization is `allowedRoles` (chat) or the gateway's sender check (webhook) |
| `delegated` | caller's token | caller's token | yes | caller's token |
| `hybrid` | caller's token | agent credential, repo-scoped | yes | caller's token |

- **Mode applies to *resource* providers only.** `claude` and `claude-remote`
  are *runtime* providers: the model credential, not access to a system the
  agent acts on. They keep resolving as today in every mode. Everything else
  (`github`) is a resource provider. The classification is a fixed set in
  `authz` (`RuntimeProviders`, `WriteCapableProviders`), not
  `IdentityProvider` CR data, because the Temporal engine doesn't watch
  `IdentityProvider` CRs at all: its provider → env var table is fixed too.
  Moving both into the CRD is a follow-up for when the engine watches it.
- **`identityProviders` keeps its meaning:** the providers this agent *can* use
  on the caller's behalf. The mode decides whether they are resolved for a given
  run. An `agent`-mode run resolves no resource provider, even a declared one.
- **Unset is backwards compatible:** `github` declared → `hybrid`, otherwise
  → `agent`. That is exactly what the Helm `identityLink.enabled` toggle
  produces today, since it sets `identityProviders` and
  `GITHUB_IDENTITY_DELEGATION` together. The Helm charts therefore leave
  `defaultIdentity` unset: setting it to `hybrid` explicitly would change
  webhook behaviour (see "shared callers" below), where inference keeps it.
- **`allowedIdentities`** defaults to all three. It lets an Agent author forbid
  a trigger from downgrading a `delegated` agent to `agent`, which would widen
  access to the App's full installation.
- **Shared callers.** A webhook relay's service identity or a cron tick is no
  one person, so it has no caller credential to act as.
  - With an *inferred* mode, the pre-0049 behaviour is kept exactly: the run
    is narrowed to `agent` and gated on the vouched-for sender.
  - With an *explicit* `delegated`/`hybrid` (the Agent's default or the
    trigger's override), the launch is refused rather than quietly run as
    the App. §5–6 turn that refusal into a resolvable `403` once a sender can
    resolve to a delegated subject.
  - An explicit `agent` mode runs from a shared caller with no sender too
    (e.g. a cron trigger), since the operator said it acts as itself.

### 2. The mode is decided once and plumbed, never inferred

The Temporal pre-flight (`authz.Authorize`) computes

```
effective = trigger.identity ?? agent.defaultIdentity ?? inferred
assert effective ∈ agent.allowedIdentities  → else `misconfigured`
```

and builds its provider plan from it. The verdict carries the mode, and the
AgentRun gets `spec.identityMode`. The controller maps that to
`AGENT_IDENTITY_MODE` (alongside `AGENT_READ_ONLY`).

Agent images switch on `AGENT_IDENTITY_MODE` and stop inferring from token
presence:

- `agent`: App token for git and `gh`, repo-scoped via
  `AGENT_TARGET_REPOSITORY`. No `GITHUB_TOKEN` is injected.
- `hybrid`: today's 0041 behaviour (`insteadOf` read / `pushInsteadOf` write,
  `gh` shim).
- `delegated`: the caller's token for both. No `pushInsteadOf` and no App
  minting. The commit author is the caller, not a `Co-authored-by` trailer.
  A missing `GITHUB_TOKEN` is a hard start-up failure, never a silent
  fallback to the App.

`GITHUB_IDENTITY_DELEGATION` is deleted. The duplicated `identityDelegation.ts`
in `claude-code-swe-agent` and `opencode-swe-agent` moves into
`framework/github-app-auth`, so the mode switch exists once.

**A run with no `AGENT_IDENTITY_MODE` still infers.** Only a launch the
pre-flight decided carries a mode. A nested sub-agent, or the agent behind an
agent-backed tool, has no `Authorize` decision of its own, and neither does
anything launched by the LangGraph engine. Those runs fall back to the
pre-0049 inference: a `GITHUB_TOKEN` plus App credentials → `hybrid`,
otherwise `agent`. That is exactly what the deleted flag gated, since Helm
always set it together with the `github` provider.

**`readOnly` composes and only restricts.** It withholds the caller's
`GITHUB_TOKEN` after the read gate has checked access with it. Leaving a
user token in a read-only run would make "read-only" rest on the agent's
command filter alone, because the token carries whatever write access the
human has. A read-only `delegated`/`hybrid` run is therefore given `agent`
mode: it reads with a `contents:read` App token, scoped to the checked
repository. Its audit record keeps the requested mode alongside.

### 3. `agent` mode needs no provider link; the launching identity is audited

A chat caller in `agent` mode doesn't link GitHub. They are already
identified: Open WebUI forwards a signed per-user JWT, which resolves to
`openwebui:<id>` with `perUser: true`. That identity is what `allowedRoles`
authorizes, and it is what the audit trail records. The run acts as the App,
but it is always attributable to the person who launched it.

**Every decision and every launch writes an audit record**, as one JSON line
on the worker's stdout (`internal/audit`):

- `agent-authorization`: written by the `Authorize` activity for **every**
  decision (`authorized`, `link-required`, `refused`, `misconfigured`), before
  anything starts. Each decision gets a `decisionId`, stable across activity
  retries.
- `agent-launch`: written when the AgentRun is created, joined to its decision
  by `decisionId`.

Every agent launch now runs `Authorize`, even for an agent with no identity
providers (versioned with `GetVersion`, so in-flight conversations replay
unchanged).

```json
{
  "kind": "agent-launch", "outcome": "launched",
  "agent": "claude-code-swe-agent", "agentRun": "claude-code-swe-agent-7f3k2",
  "conversation": "<workflow id>", "time": "...",
  "decisionId": "<run id>/<activity id>",
  "entryPoint": "chat",                    // chat | webhook | event | api
  "launchedBy": "openwebui:8c1e...",       // the authenticated caller
  "delegatedSubject": "...",               // webhook: the subject the sender resolved to (§5)
  "sender": {"provider": "github", "login": "..."},   // webhook
  "trigger": "...",                        // webhook/event: EventTrigger name
  "requestedIdentityMode": "hybrid",
  "identityMode": "agent",                 // what the run was actually given
  "identityModeSource": "default",         // default | trigger | inferred
  "credentials": [{"provider": "github", "read": "agent", "write": "agent"}],   // never token material
  "readOnly": false,
  "targetRepository": "imaustink/agent-controller"
}
```

- This line is the durable record, because AgentRun CRs are
  garbage-collected.
- **An explicit `agent` mode never prompts a chat caller to link GitHub,** not
  even for the ADR 0031 principal step. An existing link still upgrades the
  principal, so Claude credentials resolve as before. An inferred `agent`
  mode keeps the principal prompt, since nobody opted out of it.
- It is mirrored onto the AgentRun as immutable `spec.launch`, so
  `kubectl get agentrun -o yaml` answers "who launched this, as what" while the
  run exists. The Temporal engine also has it in workflow history.
- **It is captured at launch and never re-derived.** Auto-resume once
  re-verified the 300 s Open WebUI JWT on every resume, and fell back to the
  gateway's shared identity after expiry. That is already fixed on both
  sides: `TemporalEngine.autoResumeLink` resolves the caller once, and
  `resumePendingLink` only resumes for the anchor's owner. The audit record
  relies on that and adds a test pinning it: a resumed launch records the
  original `launchedBy`.
- The Open WebUI identity is **not** written into commits or PRs. They are
  public on GitHub, and the audit log is where internal identities belong.

### 4. `EventTrigger.spec.target.identity`

```yaml
target:
  agentRef: claude-code-swe-agent
  identity: delegated     # optional override: agent | delegated | hybrid
```

- It applies to every AgentRun the turn launches, like `readOnly`. That
  includes an `orchestrator` or `skillRef` target that delegates.
- **Unlike `readOnly`, it can widen access**, so it is honoured **only** from
  the signed `x-orchestrator-dispatch-assertion`. The Temporal gateway refuses
  an `identity` in an `/invoke` body. agent-orchestrator takes it only from the
  matched trigger, never from the request.
- The EventTrigger controller sets the `Ready` condition to false when the
  override isn't in the referenced Agent's `allowedIdentities`. A bad trigger
  fails when it's applied, not on the first event.

### 5. Webhook senders resolve to a delegated subject in integration-gateway

The gateway already owns the identity-link store and already verifies the
sender. It now also resolves the sender to the subject their links are stored
under, and vouches for it.

1. **Key on the immutable account id, not the login.** GitHub logins can be
   renamed and re-registered, so a login → subject index lets whoever takes a
   freed login inherit someone's token. `EventSource.spec.sender` gains
   `accountIdFrom` (e.g. `string(body.sender.id)`).
   - The link store already has an `accountId` field (`store.ts:31`).
   - Every `github` link must now populate it, from both the chat flow and the
     Connections page.
   - The store also writes a label `aktis.ai/account-id=<provider>.<id>`, so
     the lookup is a label selector, not a scan.
   - Existing records are backfilled lazily on the next token refresh, which
     calls `/user`. Until then they don't resolve, which fails closed.
2. **Lookup** `findSubjectsByAccount(provider, accountId)` gives one of three
   results:
   - one hit → that subject;
   - none → *unlinked*;
   - several → *ambiguous* (one GitHub account linked from two Open WebUI
     users). The subject also keys every other resource provider, so picking
     one would be arbitrary.
3. **The sender assertion grows:** `{login, accountId, subject?, exp}`, still
   signed with `GATEWAY_SENDER_ASSERTION_SECRET`. The gateway mints it only
   after the webhook's HMAC verifies *and* the existing collaborator/team check
   passes. `subject` is absent when unlinked or ambiguous, with the reason. The
   gateway doesn't decide whether a link is needed: it doesn't know the
   target's mode, and `agent` mode needs none.
4. **The engines treat a verified asserted subject as a delegated caller.**
   - `Identity` gains `delegatedSubject` alongside the service `subject`, and
     resource credentials are keyed by `delegatedSubject`.
   - `perUser` stays false, so nothing interactive (link flows, principal
     re-keying) ever runs under a webhook turn.
   - This replaces the Go rule `!PerUser → skip github` (`authz.go:513`) with
     "skip unless there is a delegated subject".
   - The LangGraph engine doesn't get `delegatedSubject`. It only gets the
     shared-subject fix described under the LangGraph freeze below.
5. **Durability.** Temporal records the delegated subject in the workflow input
   when the run starts, and never re-verifies the 300 s assertion on resume.
6. **Read gate on webhooks.** In `delegated`/`hybrid` the repository is checked
   with the sender's own token, the same check as chat. The gateway's
   collaborator check stays as the admission gate. In `agent` mode only the
   gateway check applies, which is today's behaviour.

### 6. A missing identity is a synchronous `403` the webhook consumer can act on

The system never prompts or falls back on the sender's behalf. Resolving the
missing link is the consumer's job, and the response gives it everything it
needs to do so. The only exception is opt-in: a GitHub trigger can have
`reply.github.onIdentityError` post `message` as a comment (see Resolved
questions).

**The decision moves into the Temporal gateway's `/invoke` accept phase.**
agent-orchestrator matches the trigger synchronously and forwards the resolved
turn under the signed dispatch assertion. For an `agentRef` or `toolRef`
target, the Temporal gateway then resolves the effective mode. It runs the
non-interactive link check (`authz.ResolveLinked`) against `delegatedSubject`
before starting the workflow. agent-orchestrator passes its `403` straight
back to integration-gateway.

`POST /webhooks/:source` stops relaying in the background for such sources. It
awaits `/invoke` and passes the verdict through. This is well inside GitHub's
10 s delivery timeout.

```
HTTP/1.1 403 Forbidden
{
  "status": "failed",
  "error": {
    "code": "identity_link_required",      // | "identity_ambiguous"
    "message": "octocat: link your GitHub account so claude-code-swe-agent can act as you: https://gw.example.com/connections?provider=github",
    "identityMode": "delegated",
    "trigger": "ai-triage",
    "target": { "kind": "agent", "name": "claude-code-swe-agent" },
    "sender": { "provider": "github", "login": "octocat", "accountId": "583231" },
    "missing": [
      { "provider": "github", "label": "GitHub",
        "linkUrl": "https://gw.example.com/connections?provider=github" }
    ]
  }
}
```

- **403, not 401.** On this endpoint `401` already means "signature
  verification failed". A consumer must be able to tell "your request is
  untrusted" from "this person needs to link". Both cases share one status and
  are told apart by `error.code`.
- **`message` is safe to print verbatim** to the human who caused the event.
  `linkUrl` points at the Connections page (ADR 0046). It signs the user in
  through the deployment's IdP and stores the link under their `openwebui:`
  subject, with `accountId`, which is exactly the record §5 looks up. Where the
  Connections page is not enabled, `linkUrl` is omitted and `message` tells
  the user to link from chat instead.
- **It discloses nothing about other users.** `identity_ambiguous` names no
  subjects.
- **Orchestrator and skill targets can't be pre-checked**, because which agent
  launches is decided later by the planner. For those, a missing link
  surfaces after `202`, as a `failed` turn whose `GET /invoke/:id` result
  (and `reply.http` body, if configured) carries the same `error` object.

## Consequences

- An Agent CR states the identity it runs as. Webhook-triggered runs can, for
  the first time, act as the person who caused the event.
- Linking GitHub once (chat or Connections page) serves both entry points,
  because webhooks now find the link by account id.
- `agent` mode from chat needs no GitHub link. It lets any role-permitted user
  direct the App anywhere it is installed, so `allowedRoles` must be tight on
  such agents. The audit record is the accountability.
- **Nobody reads a GitHub webhook's response body.** GitHub only shows it in
  the delivery log. A GitHub-sourced `delegated`/`hybrid` trigger therefore
  fails quietly for an unlinked sender unless a consumer sits in front of the
  gateway. Open question 1 covers this.
- A `delegated` run's PRs are authored by the human. Branch protections or
  rules keyed on the bot identity will see a different actor.
- Non-GitHub resource providers (Atlassian, Slack) get `delegated` mode for
  free once their links carry `accountId`. `agent`/`hybrid` for them needs an
  agent-side credential (`IdentityProvider.spec.agentCredential`, e.g. a
  Secret or a minting strategy), which is deferred. Until then, validation
  rejects `agent`/`hybrid` for an Agent whose resource providers have no agent
  credential.

## Rollout (PR sequence)

All engine work below is in the Temporal engine (`orchestrator/engines/temporal`).
agent-orchestrator changes only where it is the router in front of Temporal:
it matches triggers, signs the dispatch assertion, and passes through the
Temporal gateway's verdicts.

1. *(No longer needed: the auto-resume identity collapse is already fixed
   on `main`.)*
2. **API + plumbing, chat only.**
   - `defaultIdentity`, `allowedIdentities`, `AgentRun.spec.identityMode` /
     `spec.launch`, then `make manifests`. (The release workflow bumps chart
     patch versions itself.)
   - Mode resolution in `authz.Authorize`, plus the audit record.
   - `AGENT_IDENTITY_MODE` and the shared `framework/github-app-auth` mode
     switch. Delete `GITHUB_IDENTITY_DELEGATION`.
   - Helm leaves `defaultIdentity` unset, so inference keeps today's behaviour.
   - The LangGraph freeze from the section below.
3. **Trigger override.** `target.identity`, carried in the dispatch assertion
   and refused in the Temporal gateway body. Controller `Ready` validation
   against `allowedIdentities`.
4. **Gateway sender → subject resolution, and the 403.**
   - `accountIdFrom`, `accountId` on every github link, the account-id label
     and backfill on refresh.
   - The extended sender assertion and `delegatedSubject` in the Temporal
     engine.
   - The accept-phase link check in the Temporal gateway's `/invoke`. It is
     passed through agent-orchestrator to a synchronous webhook response, with
     the `identity_link_required` / `identity_ambiguous` error object.
   - `reply.github.onIdentityError`.
5. **Later:** `IdentityProvider.spec.agentCredential` for non-GitHub
   providers, and `defaultIdentity` on Tool / MCPTool.

### The LangGraph engine is frozen, and fails closed

The in-process LangGraph engine (`AGENT_ENGINE=langgraph`) is headed for
deprecation, so none of this is built on it. It must still never silently
ignore a mode it doesn't implement:

- **Unchanged behaviour when nothing is set.** With no `defaultIdentity` and no
  trigger `identity`, it runs exactly as today. The mode is inferred, and
  `github` declared means `hybrid`. Its launcher sets `AGENT_IDENTITY_MODE`
  from that inferred mode, which lets the agent images drop `isDelegating()`
  for both engines.
- **An explicit mode is refused.** If an Agent's `defaultIdentity` is set, or a
  trigger sets `target.identity`, the run gets a `misconfigured` verdict and
  launches nothing. The error says the field requires the Temporal engine.
- **One security fix is kept despite the freeze.** It skips `github` for a
  shared (non-`perUser`) subject, as Go does
  (`authorization-service.ts:574-594`). Without it, the first person to link
  under the webhook service identity becomes every sender's GitHub identity.
  The fix is small and independent, so it can ship ahead of PR 2.
- **No ADR 0042 read gate port** (it was never on this engine).
- **Deprecation itself is a separate ADR.** That ADR covers the e2e suite and
  any deployment still on `langgraph`.

### Verification

Run a matrix of mode (`agent`/`delegated`/`hybrid`) × entry point (chat,
webhook) × `readOnly` on the Temporal engine. Each cell asserts which token git
fetch, git push and `gh pr create` actually used, by its `/user` identity, not
by which env var was set. It also asserts the cell's `agent-launch` audit
record. Each assertion must be shown to fail by breaking the wiring once,
because dead assertions in this harness have hidden real bugs before.

Webhook-specific cases:
- an unlinked sender → `403 identity_link_required` with a working `linkUrl`;
  then link through it, replay the same delivery, and expect `202`;
- an ambiguous sender → `403 identity_ambiguous`;
- an `agent`-mode trigger with an unlinked sender → `202`;
- a bad signature → still `401`;
- a renamed login (account id matches) and a freed login reused by another
  account (account id doesn't);
- a body `identity` to the Temporal gateway → `400`;
- an expired assertion on resume, where the run must keep its delegated
  subject.

e2e chat specs run on `claude-code-swe-agent` rather than stubs, so changing
its `defaultIdentity` moves every chat identity spec. Pin it explicitly in
e2e values.

## Resolved questions

1. **GitHub-sourced triggers post the error.** `reply.github` gains
   `onIdentityError: true` (opt-in). When the accept phase returns
   `identity_link_required` / `identity_ambiguous`, the gateway posts
   `error.message` as a comment on the issue or PR.
   - It reuses the ack path's repository and issue number, and its App
     credential.
   - It still answers the webhook with the same `403`, so a consumer in front
     of the gateway sees the same thing.
   - It posts one comment per delivery. GitHub doesn't retry deliveries, so
     there's no dedupe beyond that.
2. **Temporal only.** `delegated`/`hybrid`, the trigger override and webhook
   sender resolution are built only on the Temporal engine. The LangGraph
   engine is headed for deprecation (see below).
