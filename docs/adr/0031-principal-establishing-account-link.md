# 0031. Establishing a principal is its own pre-flight step, not a side effect of `identityProviders`

Date: 2026-07-25

## Status

Accepted

Amends [0029](0029-canonical-github-credential-subject.md) (canonical credential
subject) and [0030](0030-authorization-preflight-outside-the-llm.md) §5/§6.

## Context

ADR 0029 converged Claude credentials on a canonical `github:<login>` principal
so that authorizing once during GitHub triage is honored in Open WebUI chat and
vice versa. In production, it converged in one direction only, and the
asymmetry left the original bug fully intact for the flow it was reported from:

```
15:57:10 [authorization] {"verdict":"authorized",   "agentId":"claude-code-swe-agent", "actorLogin":null}
16:12:33 [authorization] {"verdict":"link-required","agentId":"claude-code-swe-agent", "pending":["claude@github:imaustink"]}
```

Same human, fifteen minutes apart, one working and one prompting:

- **The webhook path always has a login.** `senderLogin` rides on `/invoke`'s
  event descriptor, so `resolvePrincipal` always returns `github:<login>` and
  the turn reads `claude@github:imaustink`.
- **The chat path can only read one off an existing `github` link.** There was
  none, so `resolveActorLogin` returned `undefined` (`actorLogin:null` above),
  the principal fell back to the raw `openwebui:<id>` subject, and chat happily
  kept reading and writing `claude@openwebui:<id>`.

Neither flow is broken on its own. They simply never meet, permanently, and no
amount of authorizing in one fixes the other.

What made the chat side unable to learn a login is that a `github` link only
ever came into existence as a **side effect of an Agent's
`identityProviders`** — and ADR 0030 §5 deliberately removed `github` from
`claude-code-swe-agent`'s list, because declaring it to obtain a *mapping* also
provisioned a `GITHUB_TOKEN` into the run and activated the agent's
delegated-write path, which is what produced the observed
`401 Bad credentials`. ADR 0030 named the conflation ("obtaining an identity
mapping and provisioning a credential are different concerns") and removed the
symptom, but the only mechanism for obtaining a mapping was still the one that
provisions a credential. So the fix for the 401 silently switched off cross-flow
sharing for every chat caller.

## Decision

Establishing a principal becomes its own step in the authorization pre-flight,
independent of what the Agent declares.

When a run needs a credential that is keyed by principal
(`CROSS_ENTRY_POINT_PROVIDERS` — `claude`, `claude-remote`) and the caller has
no canonical principal yet, the pre-flight first establishes one with an
ordinary `github` link that is **link-only**: it contributes the login and
nothing else, and its token is never added to `secretEnv`. Mapping and
credential are now separately reachable, which is what ADR 0030 §5 asked for.

Four properties make this safe, and each is pinned by a test:

1. **Per-user subjects only.** `Identity` gains `perUser?: true`, asserted by
   the resolver that structurally knows it (`OpenWebUiForwardedUserResolver`)
   and absent everywhere else — including the OIDC resolver, which cannot tell a
   human's token from integration-gateway's own service-account token. Without
   it, no principal is established. This is the security core of the change: a
   login filed under the shared service subject would be inherited by every
   later `senderLogin`-less webhook turn, handing one person's Claude
   credentials to everyone — the shape of the leak
   [0022](0022-per-user-github-device-flow-identity.md)'s successor fix and the
   PR #144/#145 revert both landed on. A live channel (`progressListener`) was
   considered as the signal and rejected: a shared subject arriving on a
   streaming caller would pass it, so it is unsound in the one direction that
   leaks.
2. **The principal step runs first, so CRD provider order stays irrelevant**
   (ADR 0030 §4). A `[claude, github]` Agent must not key its Claude credential
   before the login is known.
3. **A pending principal link stops the turn there.** The remaining providers
   would have to be keyed by a subject the caller is one link away from
   abandoning, and starting their flows would file the credentials the user is
   about to create under the raw subject — re-creating the very split this
   closes. The resume turn re-enters with a canonical principal and assesses
   everything then. This is a deliberate exception to §4's batching: batching
   assumes the providers are independent, and these are not.
4. **Every failure degrades rather than blocks.** A link that won't start, or
   one carrying no login, logs and continues on the raw subject — sharing is an
   improvement, not a precondition, and a GitHub OAuth hiccup must not deny a
   run whose own credentials are already linked.

### Existing credentials are moved, not re-authorized

Both flows reading one key does not by itself put anything at that key. Records
written before principals existed sit under the entry point's own subject, so a
caller who has been running agents from chat for weeks would still have met a
login prompt on the turn after this shipped — for a credential the gateway is
holding the whole time. "Authorize once more, this last time" is the kind of
cost that reads as the bug not being fixed, and it is avoidable.

The gateway gains `ClaudeTokenStore.rekey` and a bearer-gated
`POST /claude-auth/api/rekey`, and the pre-flight calls it lazily: when nothing
is stored at the principal, it moves the caller's pre-principal record onto it
and re-reads. Design points worth stating:

- **Lazily, on the turn that needs it, not as a migration job.** The
  (subject → principal) mapping is only derivable from a caller's own
  authenticated turn; a batch job would have to invent it.
- **Gated on `perUser`, exactly like establishing a principal.** A shared
  subject's credential belongs to whoever authorized first, so moving it onto a
  sender's principal would hand it to them outright. The webhook path never
  adopts — it reads only what its own principal already holds. This is also what
  keeps `identity-keying.e2e.ts`'s negative controls meaningful.
- **Moved, not copied.** The `claude-remote` write-back only ever writes the new
  key, so a leftover copy would silently rot and then fail whichever flow still
  read it with "Login expired" — worse than either alternative.
- **Never overwrites the destination.** A record already at the principal is by
  definition at least as current as the one being moved.
- **The source is deleted only after the destination read back.** `set` swallows
  its own Redis errors by design, so an unverified delete could drop a human's
  only credential on a transient failure — the one outcome strictly worse than
  the extra login this avoids.
- **Best-effort throughout.** A failed rekey leaves the credential where it is
  and the turn falls back to the ordinary link prompt; it never fails a turn.

The `authorized` verdict now carries the `principal` the credentials were
actually keyed by, and `delegateToAgent` adopts it for the rest of the turn.
Without that, the expired-credential path would re-derive the pre-upgrade key,
invalidate a record that was never written, and tell the user to retry — the
infinite "expired credential" loop that path exists to prevent.

### Post-deploy: the mapping must not depend on a usable token

Deploying the above produced a link prompt on **every** chat turn for a caller who
had linked months earlier — while the turn then completed successfully 0.3s later.
Two defects, one of them pre-existing and load-bearing:

1. **The pre-flight asked a credential question to decide an identity one.**
   `getToken` routes to the gateway's `getValidToken`, which returns nothing for a
   link whose access token expired and could not be refreshed. The pre-flight read
   that as "this caller has no GitHub identity" and offered a link — but
   `waitForCompletion` reads the stored record RAW, so it resolved the same login
   immediately, the principal came out canonical, the credential was adopted, and
   the run launched. The prompt was pure noise, unavoidable, and every turn.

   An access token that expired overnight does not unprove which account someone
   controls. So the gateway gained `GET /identity-link/:provider/identity`
   (`getLinkedLogin`), returning the record's login and **never** a token, and
   both `resolveActorLogin` and the principal step now use it. This is the same
   separation the ADR is about, applied one level down: mapping and credential are
   different questions of the same record.

2. **`refreshUserToken` omitted `client_secret`**, which GitHub requires for the
   refresh grant. So the refresh failed for every link, the caller read that as
   "dead link, make them re-link", and **every GitHub link expired ~8h after
   creation and could never renew** — with a six-month-valid refresh token sitting
   unused. Pre-existing, and invisible until §1 started acting on the result. The
   parameter is now required rather than optional, a missing secret is logged
   rather than silently treated as a dead link, and the failing refresh path logs
   its reason.

A third, smaller correction from the same investigation: a lookup that ERRORS is
not an answer of "no link". It now degrades to the raw subject **without**
offering a link, so a gateway blip costs a turn its sharing rather than putting a
one-time-setup prompt in front of someone who completed it long ago.

## Consequences

Chat and triage converge on one record for the same human, which is the whole
point. The first chat turn after this change costs that caller exactly one
one-time prompt — link GitHub — and their existing Claude credential is carried
onto the principal underneath it. ADR 0030's "at most one extra prompt per user,
once" migration cost is retired rather than paid: the gateway holds both records
in one store, so moving one is a store operation, not a re-authorization.

`identityProviders` semantics are unchanged from ADR 0030 and now actually hold:
declaring a provider means "this run needs this credential," never "this run
needs to know who the caller is."

Costs and limits, stated plainly:

- **A caller whose subject is not asserted per-user gets no sharing.** Today
  that means anyone reaching chat other than through Open WebUI's forwarded-user
  JWT. They keep working, on their own per-entry-point keys.
- **A caller who never links GitHub keeps their credential where it is.** No
  principal, no adoption, no sharing — and nothing lost.
- **The read side of the mapping still trusts a link under whatever subject it
  finds**, including a shared one, if a leftover record exists there
  (`resolveActorLogin`). This change never *creates* one there, but it does not
  clean up a pre-existing one; the identity-link store has no TTL. Removing that
  hazard belongs with ADR 0030 §6's alias table, where a principal stops being
  "whatever GitHub link happens to be present."
- **`resolveLinkedCredentials` (the agent-backed-tool path) cannot establish a
  principal**, because it must not start a link flow — a paused *tool* call has
  no resume slot. It reads whatever principal the turn already has. Same
  documented v1 scope cut as before.
- **e2e now drives both entry points.** The webhook-only suite is how a
  one-directional convergence shipped in the first place, so `e2e/support/chat.ts`
  was added: it mints the per-user `X-OpenWebUI-User-Jwt` Open WebUI signs and
  posts a streaming `/v1/chat/completions`. `identity-keying.e2e.ts` gained the
  chat-side cases — resolves from the principal, adopts a pre-principal record
  without re-prompting, refuses another human's credential, and still works with
  no GitHub link at all — plus `chat-harness.e2e.ts`, which checks the harness's
  own signing against the real resolver and needs no cluster. The standing rule:
  when behaviour differs per entry point, cover it from each of them.
- **The GitHub link is seeded in e2e, not established.** A real device/authcode
  round trip needs github.com and a human with a browser. The orchestrator reads
  only `githubLogin` off that record, so the path under test is identical; what
  is NOT covered end-to-end is the OAuth exchange itself, which was already true
  before this change.
