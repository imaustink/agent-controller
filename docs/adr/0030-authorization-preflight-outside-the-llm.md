# 0030. Authorization is a deterministic pre-flight the orchestrator owns, and the LLM can neither decide it nor see credentials

Date: 2026-07-25

## Status

Proposed

Amends [0029](0029-canonical-github-credential-subject.md) (canonical credential
subject) and [0022](0022-per-user-github-device-flow-identity.md) /
[0027](0027-per-user-claude-oauth-setup-token-delegation.md) (per-user GitHub
and Claude delegation). Nothing here is retracted; 0029's canonical subject
remains the interim keying until the principal model below lands.

Amended by [0031](0031-principal-establishing-account-link.md): §5's removal of
the `github` provider from `claude-code-swe-agent` fixed the 401 but left chat
callers with no way to learn their own login, so §6's convergence held on the
webhook path only. 0031 makes establishing a principal its own pre-flight step
rather than a side effect of `identityProviders`.

## Context

Authorization currently lives in three places, with overlap:

| Layer | Decides |
| --- | --- |
| integration-gateway | May this sender trigger anything? (team membership, collaborator permission) |
| agent-orchestrator's identity gate | Which credentials must exist before an Agent launches? |
| the SWE agent itself, at runtime | Who is this token? May they write this repo? Who gets attribution? |

The third row is the defect. `delegateToAgent` already refuses to launch until
every provider a CRD declares in `identityProviders` is resolved and injected
as `secretEnv` — so by the time a run starts, the orchestrator has *already*
established the caller's authorization. The agent then re-derives it anyway:
`identityDelegation.ts` calls `fetchGithubUser`, checks
`fetchCollaboratorPermission`, and mints an installation token.

That duplication is not theoretical. A production run failed with
`Failed to look up GitHub user: 401 Bad credentials` from the agent's own
`/user` call — a code path that only became reachable when
`claude-code-swe-agent` gained the `github` provider, and which the
orchestrator had no reason to invoke at all. Collaborator-permission checking
also exists in two separate implementations (gateway and agent).

Three further problems were observed standing the system up end-to-end
(docs/adr/0029's rollout, verified on minikube):

1. **The gate is sequential and short-circuits.** It bails on the *first*
   unresolved provider, so an Agent declaring N unlinked providers costs the
   user N separate triggers, each discovering the next gap.
2. **Ordering is load-bearing and fragile.** Because resolution short-circuits,
   a failure in an unrelated provider ends the turn before later providers are
   reached — observed as `start threw for provider github; ending turn`, which
   blocked Claude authorization entirely on a GitHub OAuth failure.
3. **Declaring a provider conflates two unrelated things**: obtaining an
   identity *mapping* and provisioning a *credential*. Requiring `github` to
   get the former is what activated the latter, and hence the 401.

Underneath all of it: integration-gateway resolves the sender's identity for
its own gate, then authenticates to `/invoke` as itself. The orchestrator sees
one shared service subject and reconstructs the human from a `senderLogin`
field riding in a routing descriptor.

## Decision

### 1. One authorization owner, deterministic, outside the LLM — DONE

The *property* held from the start and is what matters: authorization runs as
graph control flow in `delegateToAgent`'s pre-flight, never as a capability a
planner selects, and §3's test pins the credential boundary. The extraction into
a named class is now done too (`agent/authorization-service.ts`), as a pure
refactor — the full pre-existing orchestrator suite passes unchanged, with new
unit tests added for the now-directly-reachable verdicts.

Two things came out of doing it that the "it's only cosmetic" framing missed.
The verdict is now a **total discriminated union**
(`authorized` | `link-required` | `misconfigured`), so a fourth outcome breaks
compilation at the branch rather than falling through to "launch anyway" — the
failure direction that actually matters. And the agent-backed-tool path, which
had its own hand-copied provider loop with the same keying rules, now calls the
same owner via a deliberately separate read-only entry point
(`resolveLinkedCredentials`) — it must not start a link flow, because a paused
*tool* call has no resume slot. Two copies of credential keying was exactly the
shape of the #144 bug; §1 is what removes the second copy.

A single `AuthorizationService` in agent-orchestrator owns every authorization
decision: which providers an Agent requires, whether they are satisfied, what
identity they resolve to, and what permission that identity holds.

It is **plain control flow** — a graph pre-flight node, not a capability the
planner selects. No model call participates in an authorization decision. This
is a security boundary, not a style preference: an LLM that can choose whether
authorization succeeded is an LLM that can be argued into saying yes.

### 2. The LLM's only authorization-adjacent capability is asking a human to link

**Not built — and on implementation review, it should not be.** The
deterministic pre-flight already surfaces every link prompt a caller needs,
including the batched multi-provider case (§4). Adding a model-callable tool
would introduce an LLM-reachable authorization surface to solve a problem that
no longer exists, which is the opposite of this ADR's intent: the smallest
attack surface is the one that isn't there. The constraints below are retained
as the specification any future such tool must satisfy, should a genuine need
appear.

Were it exposed, exactly one narrow tool:

```
request_account_link(provider: "github" | "claude" | "claude-remote") -> { promptText, url }
```

Constraints, all enforced at the call boundary rather than by prompt:

- **It takes no subject.** The subject comes from the verified identity on the
  turn's state. A model-supplied subject would let a caller request — and then
  be handed — a link flow keyed to someone else.
- **It returns no credential**, only a URL and human-readable text.
- **It cannot report success.** Whether a link completed is read from the store
  by the deterministic pre-flight on the next turn, never from model output.
- **It is not required for the normal path.** The pre-flight already surfaces
  link prompts; this tool exists only for a model mid-conversation that needs
  to re-offer one.

### 3. Credentials never enter model context — IMPLEMENTED (test)

A resolved credential is an opaque handle inside the graph:

```ts
/** Redeemable ONLY by the AgentRun launcher. No accessor returns the secret. */
type CredentialHandle = { readonly provider: string; readonly ref: symbol };
```

The plaintext value travels gateway → launcher → Kubernetes Secret →
`AgentRunSpec.SecretEnv`, and is never assigned to an `AgentStateAnnotation`
field, never interpolated into a prompt, and never logged. Today's
`identitySecretEnv` is already a node-local variable rather than graph state;
this makes that property explicit and type-enforced instead of incidental.

Enforced by:
- **Type** — no accessor on `CredentialHandle` returns the value; only the
  launcher can redeem it.
- **Test** — an assertion that no credential material appears in any outbound
  model request payload, run against a turn that resolves every provider.
- **Log discipline** — the existing debug lines print subjects and env var
  *names* only, never values (the e2e helpers follow the same rule).

### 4. Batch pre-flight, not first-miss — IMPLEMENTED

The pre-flight resolves **every** declared provider, collects **all**
unsatisfied ones, and presents them together in a single turn. Launch happens
when the whole set is satisfied.

This removes the N-triggers cost and makes ordering irrelevant: nothing
short-circuits, so no provider's failure can prevent a later one from being
evaluated. A provider that fails to *start* is reported alongside the others
rather than ending the turn.

### 5. The agent receives a sealed authorization context — IMPLEMENTED

The launcher injects resolved facts, so the agent performs no identity work:

```
AGENT_ACTOR_LOGIN      resolved GitHub login
AGENT_ACTOR_ID         numeric id, for the co-author trailer
AGENT_ACTOR_PERMISSION verdict already checked by the orchestrator
```

The agent stops calling `/user` and stops re-checking collaborator permission.
The 401 is fixed **by construction** — the call that produced it no longer
exists — and the duplicate permission implementation is deleted.

*Amended during implementation — this trade-off turned out to be avoidable.*
The login is read off the caller's stored `github` link record, which already
contains it, rather than from a `/user` call. So the orchestrator needs **no**
GitHub App credentials and makes no additional API request. The numeric id is
the only casualty: it is not stored on the link, and fetching it would
reintroduce the very round trip being removed, so the co-author trailer falls
back to its `login@users.noreply.github.com` form. GitHub still attributes
correctly; the attribution just isn't pinned across an account rename.

### 6. Identity is forwarded, not reconstructed — IMPLEMENTED

integration-gateway sends its service token for *authentication* and a
**signed user assertion** for *identity* — the same pattern
`OpenWebUiForwardedUserResolver` already uses for Open WebUI's per-request JWT,
and for the same stated reason: resolving identity from a shared bearer token
collapses every user into one subject.

**As built**, the assertion is a compact HMAC-SHA256 `payload.signature` pair
(`x-gateway-user-assertion`) rather than a JWT: both ends live in this repo,
the only claims needed are a login and an expiry, and hand-rolling it with
`node:crypto` avoids adding a JWT library to the gateway purely to agree with
the orchestrator's — the same no-new-dependency precedent as `githubApp.ts`.

With the shared secret configured, `/invoke` accepts a sender login ONLY from
a verified assertion and ignores the request-body field entirely. Without it,
the body field is still trusted and BOTH processes warn at startup — chosen so
upgrading does not silently break an existing deployment, while never leaving
the weaker mode unannounced.

Rather than rewriting `identity.subject` itself (which would move session
keys, RBAC scoping and credential keys simultaneously), the verified login
feeds **principal** resolution: `Identity` gains a `principal` field, resolved
once in `resolveIdentity` and read everywhere downstream. Entry-point subjects
remain aliases; durable per-user state keys on the principal. This keeps
sessions and RBAC on the subject they have always used while credentials
converge, which is the whole point — and it retires
`resolveCredentialSubject`, whose per-provider re-derivation was the shape of
the PR #144 bug.

Entry-point identities then become **aliases of a principal** — a stable
internal user id — with credentials keyed by principal. `github:<login>` is
today's stand-in for exactly this, chosen because GitHub was the one
identifier both flows could reach. Formalizing it means cross-flow sharing
works for any future entry point with no new keying code, `resolveCredentialSubject`
is deleted, and account linking becomes a user-level action rather than a side
effect of an Agent's provider list.

## Consequences

The 401 disappears without being debugged, because the agent no longer performs
the lookup. Ordering stops mattering. Users authorize once, for everything an
Agent needs, in one round trip. Authorization has one implementation and one
owner.

The LLM cannot approve, deny, or observe authorization. It can ask a human to
link an account and nothing else — and because the tool takes no subject and
returns no secret, prompt injection cannot escalate through it.

Costs, stated plainly:

- The orchestrator holds the GitHub App credentials (see §5).
- `identityProviders` semantics change: declaring a provider means "this run
  needs this credential," and identity mapping no longer rides on it. Charts
  that added a provider purely to obtain a mapping should drop it.
- Principals require a migration: existing credentials are keyed by
  `identity.subject` or `github:<login>` and are not rewritten. The first
  authorization after the change writes the principal-keyed record — at most
  one extra prompt per user, once.
- Steps 4 and 5 are independently shippable and remove three observed defects
  on their own; 6 is the deeper change and can follow.

An e2e suite covering these paths exists (`e2e/`), because none of the defects
above were visible to unit tests — every one of them required the assembled
system to be running.
