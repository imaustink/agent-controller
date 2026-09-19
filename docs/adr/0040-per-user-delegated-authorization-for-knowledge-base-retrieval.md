# 0040. Per-user delegated authorization for knowledge-base retrieval: the mirror pre-filters, the source decides

Status: proposed

## Context

Ingestion (ADR 0038) runs on a shared service credential with total visibility,
deliberately: the index must be built once and shared, so it cannot be built
through any one user's eyes. A Confluence connection indexes every page in its
space whether or not the person asking today may read them.

Retrieval cannot ignore permissions the same way. Each end user authenticates
via OAuth and the agent can hold a token delegated to them. The agent must never
surface content — **or evidence of content** — that the user could not read
directly in the source system.

That is the tension this ADR resolves: **the index is built with total
visibility but must be read through a much narrower lens, which varies per user
and changes without telling us.**

It also corrects ADR 0039 §4. That section treats the per-chunk `Roles` written
at index time as the authorization decision, and lets citations be rendered from
chunk metadata. Under this ADR neither is true: those roles become a hint, and
citations become content.

## Decision drivers

1. **Authorization correctness.** Confluence's permission model — space
   permissions, page restrictions, inherited restrictions, group membership,
   anonymous access — is non-trivial and evolves independently of us. Slack and
   Drive each have their own, no simpler.
2. **Blast radius.** A defect in our authorization path should degrade recall,
   not disclose content. Failures should be visible as missing results, never as
   silent leaks.
3. **Avoiding reimplementation.** Any permission logic we write is a fork of the
   vendor's logic, and forks drift.
4. **Latency and API load.** Naive per-chunk hydration produces a fan-out
   proportional to candidate count on every query.

## Options considered

**A. Post-filter hydration only.** Query with no permission filtering, then try
to fetch each candidate's source with the user's token and discard what fails.
Authorization is delegated entirely to the source; we implement none of it, and
it fails closed. But it costs N API calls per query, and recall suffers badly:
if the top 50 candidates are dominated by pages the user cannot see, they get a
thin answer even when readable content exists further down the ranking.

**B. ACL pre-filter on vector metadata.** Capture each page's effective
permission set at ingestion, store the allowed principal ids as vector metadata,
filter on the user's resolved principals before similarity search. Fast, one
query, good recall — and **fails open**. A stale mirror, a mis-parsed
restriction, or a missed group-membership change silently grants access, and
nothing in the system detects it. It is also a permanent, security-critical fork
of the vendor's permission semantics.

**C. Hybrid.** Use the mirrored ACL as a non-authoritative pre-filter to shrink
the candidate set, then hydrate the survivors live with the user's delegated
token and discard anything that fails.

## Decision

Adopt **Option C**, under one governing rule:

> **The ACL mirror is a performance optimization. It is never the authorization
> decision.**

Concretely:

1. Similarity search runs against the vector store with the mirrored ACL filter
   applied.
2. Surviving candidates are hydrated against the source's API using the user's
   own OAuth token.
3. Any candidate that fails to hydrate with a **permission-class** error is
   dropped — before ranking, before prompt assembly, and before citation
   generation.
4. Only hydrated content reaches the model.

Every result a user sees was, at query time, confirmed readable by the source
system itself under that user's own credentials. The mirror's only job is to
make step 2 cheap.

### There is no service-credential retrieval mode

Delegated retrieval is not a per-knowledge-base option with a service-credential
alternative. A mode meaning "this corpus has a uniform audience, skip hydration"
**fails open**: an operator sets it truthfully, the audience stops being uniform
some months later, and nothing in the system notices. Silent over-disclosure on
a config value that was correct when it was written is the precise failure this
ADR exists to remove.

The premise behind such a mode is also usually false. A corpus assembled from a
Confluence space, a Drive folder and two Slack channels almost always contains
*something* — a restricted page, a contract, a private thread — that not every
member of its nominal audience may read, whether or not anyone has noticed. A
genuinely uniform corpus loses nothing by going through hydration either: every
probe simply succeeds. The cost is latency; the benefit is that the assumption
never has to be made.

Per-user delegated retrieval is a general requirement for knowledge bases
assembled from sources that have their own permission models. It is not a
property of any particular deployment's audience.

### What this changes in ADR 0039

- **Per-chunk `Roles` stop being the authorization boundary.** They remain as
  the coarse, connection-level pre-filter (§4's "per-point to read"), but
  authorization is now hydration. 0039 §4's claim that per-point filtering
  "decides what any given caller actually sees" is superseded by this document.
- **Citations may no longer be rendered from chunk metadata.** See below.
- **The mirror is deliberately over-inclusive**, which inverts the fail-closed
  instinct applied elsewhere in the retrieval path — and is safe only because
  hydration is the real gate.

### Citations are content

Page titles, URLs, and snippet previews all leak information. They must come
from the **hydrated response**, never from vector metadata, or the design is
bypassed at the last step: an answer that cites a title the user may not read
has disclosed exactly what this ADR exists to prevent, while appearing to have
returned nothing.

This is the sharpest practical consequence, because the natural implementation —
rendering `Sources:` from the chunk payload that came back from the vector
store — is precisely the bypass.

### Error classes are not interchangeable

A 403 or 404 on hydration means **drop**. A 429, 500, or timeout means something
else entirely, and treating it as a drop makes answers non-deterministic and
quietly degraded: the same question returns different evidence depending on
whether the source was busy. Transient failures retry, or surface as an explicit
partial-results warning. They are never a silent omission.

### Candidate over-fetch

The pre-filtered search requests more candidates than the context window needs,
so hydration drops do not starve the answer. Start at **3x** and tune from
observed drop rates.

### Hydration is a probe, not necessarily a fetch

What hydration must establish is *may this user read this resource right now*.
That does not require transferring the body. So hydration splits in two:

- **The authorization probe** — live, per user, per resource, never cached
  across users. Returns allow/deny plus the resource's **title, URL and
  version**. Small payload, one round trip, and it satisfies "citations are
  content" by itself, since the displayable fields come from the source rather
  than from the mirror.
- **The content** — served from the index, and valid **iff** its version matches
  what the probe just returned. A version mismatch falls back to a full fetch.

The governing rule therefore sharpens to: **no content reaches the model unless
a live probe confirmed this user may read that exact version.** The source still
makes every authorization decision; what changes is that the body no longer
rides the hot path, and staleness is detected by comparing a version rather than
by refetching to find out.

Providers that cannot answer a cheap probe fall back to fetching, which is
correct but slower — this is an optimization, never a relaxation.

**Full-document hydration is the model's decision, not the pipeline's.** The
retrieval path probes and stops there. When a chunk is not enough to answer
from, the planner calls `kb:<name>/fetch` or the connection's own GET face
(ADR 0038 §5) and reads the live document — which is an ordinary tool call,
authorized the same way, because it goes to the source with the same delegated
token.

This is why the split costs so little. There is no separate hydration-fetch
machinery to build: the tools that fetch a whole document already exist for
their own reasons, and they are exactly what "hydrate this one properly" means.
Body transfer becomes proportional to how often an answer actually needs depth,
rather than a fixed per-candidate toll paid on every query whether or not
anything reads the result.

One consequence for ADR 0038 §5: the GET face must now carry the **calling
user's** delegated token rather than the connection's service credential.
Otherwise the model's own follow-up read becomes the way around the probe.

### Token and cache handling

The delegated token is per request and per user.

Two caches with different keys and different rules, because they answer
different questions:

- **Permission decisions** are keyed `(user principal, resource id)` with a
  short TTL — long enough to serve one conversation, short enough that a
  revoked grant takes effect quickly.
- **Content** is keyed `(resource id, version)` and **may be shared across
  users**, because it is only ever released after that user's own probe
  succeeded for that version.

An earlier draft of this ADR said a shared content cache defeats the design.
That is true only of a cache read *without* a permission check — and by that
standard the vector store is already a shared content cache, since it holds the
whole corpus ingested under a service credential. The real invariant is not
about where content is stored but about what must happen before it is released:
**content is never released without a live, per-user authorization decision for
that exact version.** Storing one copy of a page rather than one copy per reader
follows from that, and does not weaken it.

### Tuning direction

Where effective permissions cannot be confidently resolved during ingestion, the
vector is marked **permissive** and allowed through to hydration. Over-inclusion
costs a wasted hydration call. Under-inclusion silently suppresses results the
user was entitled to see, and is the only direction that causes user-visible
harm.

### Observability

Log the hydration drop rate per query, broken out by pre-filter outcome. Two
signals matter, and only one of them is visible by default:

- **Passed the pre-filter, failed hydration.** Expected. Measures mirror
  staleness in the permissive direction, which is harmless.
- **Blocked by the pre-filter but actually readable.** The harmful direction,
  and **invisible by default** — nobody reports the answer they never saw.

The second signal does not measure itself, so the sampling job that produces it
ships **with** this feature rather than after it. It is small, and it reuses
machinery ADR 0038 §6 already builds:

A controller-owned CronJob runs a fixed set of canned queries for a few test
principals, twice: once through the pre-filter, once bypassing it. Both arms are
hydrated **with that test user's own token**, and anything that hydrates
successfully but was excluded by the pre-filter is a harmful-direction miss.
Emit the rate as a metric.

Two properties make this safe and worth having. It needs no privileged access —
both arms run as the test user, so the job cannot itself surface anything that
user could not read. And it yields the single number that says whether the
mirror is tuned correctly: a miss rate at zero means over-inclusion is working,
a climbing one means the mirror has drifted restrictive and is silently costing
people answers.

The test principals must have **varied** visibility. A full-access test user can
never produce a harmful miss, so a panel of those would report a reassuring zero
forever while measuring nothing.

## Consequences

**Positive.** The authoritative check is the source system, not us — a drifted
mirror costs recall, not confidentiality. Hydration fan-out drops by roughly the
ratio of the user's visible corpus to the total corpus, which for most users is
a large reduction. The mirror may be wrong in the permissive direction without
consequence, which relaxes sync requirements considerably: it need not be
correct, only approximately correct and biased toward over-inclusion. And
content sent to the model is fresh rather than a snapshot from ingestion time.

**Deletion and tightening come free.** A page deleted or restricted after
ingestion is handled correctly by hydration with no sync at all — a meaningful
advantage over Option B, where a deleted page's vector stays queryable until the
next sync.

**Negative.** Two systems to operate, and the pre-filter still needs its sync
pipeline. The latency floor is set by hydration, not by vector search. A mirror
wrong in the *restrictive* direction silently suppresses results the user should
see; that is the failure mode we accept, and the one we must monitor for.

**Result-count leakage is reduced, not eliminated.** A user who receives four
results where the corpus suggests more can still infer that restricted material
exists. Accepted. If it later matters, the mitigation is to backfill the
candidate set rather than return a short list.

**This ADR depends on per-user identity that ADR 0038 §7 deferred**, and that
dependency is a schedule cost to plan rather than a reason to make the behaviour
optional. Retrieval requires a delegated token per user per provider — exactly
the `Connection.spec.identityProviders` path v1alpha1 postponed — including
token storage, refresh, and per-entry-point subject keying, which has caused
re-authorization loops before. Ingestion stays on a shared service credential,
correctly, since a scheduled reconcile has no calling user; the two credential
paths now coexist on one Connection by design rather than by accident. A
knowledge base is not usable under this ADR until its providers' delegation
flows exist.

**Hydration granularity is a driver property.** ADR 0038 made providers a driver
interface, and each needs a probe with a permission-class error contract — but
the *unit* the probe applies to differs, and that is not a wrinkle to work
around:

- **Confluence and Drive** authorize per resource: a page, a file. Probes are
  per candidate, deduplicated by source rather than by chunk.
- **Slack** authorizes per **channel** — membership is the access unit, and
  there is no per-message read check because there is no per-message
  permission. One probe per member connection per query settles every candidate
  from it at once, which is *cheaper* than the per-resource case, not harder.

So the driver contract declares its granularity, and a per-connection provider
short-circuits candidate-level probing entirely. A provider that can support no
probe at all cannot be exposed to users whose access differs from the service
credential's; that limit belongs in the driver contract, not in a comment.

**The driver contract grows two requirements, not one.** Alongside the probe,
the mirror needs per-resource ACLs captured during `List`/`Fetch`, which ADR
0038's interface has no notion of — it returns a Document. Confluence ACL
extraction in particular is fiddly (inherited restrictions, group expansion),
though "approximately correct, biased permissive" removes most of the pressure
to get it exactly right.

## Implementation impact

Against what exists today:

- `corpus.Search` (Go) and `searchCorpus` (TS) currently return answerable
  results. They become **candidate retrieval** — same fan-out, merge and dedupe,
  but feeding a hydration stage rather than the planner.
- The `limit` they take becomes a candidate budget (3x the context need), not
  the final result count.
- `CorpusChunk.text`, `.title` and `.sourceUrl` may no longer reach a prompt or
  a citation directly. The chunk keeps enough identity to hydrate — connection,
  source id, version — and the displayable fields come back from the source.
- A `probe` operation joins the provider driver interface (ADR 0038 §1), taking
  the user's delegated token and returning allow/deny plus title, URL and
  version — or a typed permission/transient error. `fetch`-as-user is the
  fallback when a version mismatch means the indexed copy is stale.
- The driver declares its probe granularity (per resource, or per connection),
  and ACL capture joins `List`/`Fetch` so the mirror has something to pre-filter
  on.
- The sampling job of the Observability section ships with the feature, as a
  CronJob reusing ADR 0038 §6's reconciliation.
