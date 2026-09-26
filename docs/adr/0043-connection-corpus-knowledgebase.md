# 0043. `Connection`, `Corpus`, `KnowledgeBase`: credentials, selection, composition

Status: accepted

## Context

[ADR 0038](0038-connection-crd-scoped-external-resources.md) made a `Connection`
mean *one scoped subset* of an external system — this Confluence space, this
Slack channel, this Drive folder — carrying its own provider, address,
credential reference, scope and roles.
[ADR 0039](0039-knowledgebase-crd-composed-corpora.md) then composed those into
a `KnowledgeBase`.

That shape works, and everything built on it — the provider drivers, the scope
check, per-subset collections, the sync worker — behaves as designed. The
problem is what it costs to configure. Ten Slack channels means ten
`Connection` resources, each repeating the provider, the workspace address and
the same `secretEnv` block, differing only in a channel id and a role list.
Rotating the token touches ten objects. Adding a channel means creating a CR
rather than editing one.

The duplication is a symptom. `Connection.spec` is answering two different
questions with one field:

- **What may this credential reach at all?** A property of the *credential* —
  one Slack workspace, one Confluence site, one Drive account.
- **Which subset of that do we index, gate and compose?** A property of the
  *material* — this channel, this space, this folder.

Collapsing them forces one resource per subset, and drags the address and the
credential along for the ride every time.

It also strains the name. In ordinary usage a "connection" *is* the first
thing: an authenticated route to a system. Ours means the second.

## Decision

Split the two questions into two resources, and let `KnowledgeBase` keep doing
exactly what it does today.

```
Connection      provider + address + credentials      one per Slack workspace,
                                                      Confluence site, Drive account

Corpus          a scoped subset of one Connection     one per channel, space, folder
                + allowedRoles + sync policy          owns one vector collection

KnowledgeBase   composes Corpora                      unchanged from ADR 0039
```

> A `KnowledgeBase` composes Corpora. Each `Corpus` draws a scoped subset from a
> `Connection`.

### 1. `Corpus` is today's `Connection` with the credential lifted out

This is the part worth being explicit about, because it decides how much moves.
The middle tier is not a new concept. It is ADR 0038's `Connection` — same
scope, same roles, same driver, same collection, same sync semantics — with
`provider`, the service address and `secretEnv` replaced by a
`connectionRef`.

Most of what hangs off it is therefore unchanged: the scope check that refuses
a resource outside the subset, per-subset collections and the fan-out that
merges them (§1 of 0039), per-point roles written at ingest, and the per-user
probe (0040). None of that is reopened here.

The exception is webhook delivery, which the split genuinely does change — see
§4.

### 2. Why the subset is the unit, and not the KnowledgeBase

The obvious simpler design is two tiers: `Connection` holds credentials, and
the `KnowledgeBase` names the channels it wants. It fails on access control.

A chunk is written **once**, stamped with the roles of the thing that produced
it. If selection moves to the KnowledgeBase, roles have to live either:

- on the `Connection`, where they are workspace-wide — so `#exec-private`
  cannot be gated differently from `#general`, which is most of why anyone
  scopes at all; or
- on the KnowledgeBase's selection — in which case two knowledge bases
  selecting the same channel with different roles have no coherent value to
  stamp. The more permissive one wins and the restriction is decorative, or the
  channel is indexed once per knowledge base, which is precisely the
  re-embedding that per-subset collections exist to avoid.

Access control has to be a property of the material, not of the view onto it.
Otherwise adding a permissive knowledge base silently widens access to someone
else's channel.

`Corpus` is that property's home. It is also, not coincidentally, the sync unit
(a reconcile pass enumerates a bounded subset rather than a whole workspace)
and the collection unit (a subset shared by several knowledge bases is embedded
once).

### 3. A `Connection` caps what its Corpora may reach

A `Connection` MAY declare an allowlist bounding the subsets that can be built
from it. A `Corpus` outside that bound is refused at admission.

The reason is that the credential holder should decide what the credential is
permitted to pull. Without a cap, anyone who can create a `Corpus` can reach
anything the token can, and the broker would be taking the caller's word for
what is in scope. With one, the bound sits next to the credential and the
driver's scope check keeps the property that makes it trustworthy: it needs no
input from the request.

The cap is optional. A `Connection` that omits it permits any subset, which is
the right default when creating a `Corpus` is already privileged.

### 4. Sync under the split

Reconcile is unaffected. A pass still enumerates one `Corpus` and still governs
what may be deleted, which is the property ADR 0038 §4 rests on — webhooks
remain an optimization over it, never a replacement.

Webhook DELIVERY does change, and this is the one place the split has real
consequences rather than cosmetic ones. A provider signs and delivers per
integration: one Slack app, one Confluence site. That is a `Connection`, not a
`Corpus`. So a single delivery now has to reach however many Corpora cover the
thing that changed — zero, one, or several.

Three consequences follow:

- **The endpoint and the signing secret belong to the `Connection`.** One
  registration per app, verified once. A per-`Corpus` endpoint would mean
  registering the same webhook N times against the same provider integration.
- **The driver stops filtering and starts reporting.** Today
  `parseWebhook(request, secret, scope)` is handed a scope and returns the ids
  inside it. It should instead return the **scope key** it is about — the
  channel id, space key or folder id — alongside the ids, and let the broker
  route. The driver cannot do the filtering any more, because it no longer
  knows which subsets exist.
- **Routing fans out.** Every `Corpus` whose scope matches the reported key gets
  a partial pass. Several matching is legitimate: two Corpora may overlap, and
  both need the update. None matching is the ordinary case — most events in a
  workspace concern channels nobody indexed — and stays a verified-but-ignored
  200, because providers disable endpoints that return errors.

Two lifecycle rules fall out of the same reasoning:

- **A `Connection` with Corpora referencing it must not vanish underneath
  them.** Deletion is refused while any remain, rather than cascading: cascading
  destroys indexed material as a side effect of removing a credential, and the
  two decisions deserve to be made separately.
- **Deleting a `Corpus` drops its collection.** ADR 0039 deliberately declined
  to delete a collection on eviction, because a collection might be reachable
  from several knowledge bases. That caution does not apply here: a collection
  belongs to exactly one `Corpus`, so nothing else can be relying on it.

Editing a `Corpus`'s scope needs no special handling, which is worth stating
because it looks like it should. The next full pass enumerates the new scope and
deletes whatever it did not see — so the collection converges on its own, by the
same rule that makes a deletion upstream eventually take effect.

### 5. Naming

`Corpus` rather than `Source`, `Workspace` or `Dataset`, for reasons that are
not only aesthetic:

- The **code already calls it this**. `vectorstore.Corpora`'s own doc says *"the
  per-Connection half of the vector store... there is one per Connection CR"*,
  the Go package is `corpus`, and `corpus.Search` fans out across them. The CRD
  name now matches the implementation instead of quietly disagreeing with it.
- `Source` collides: every chunk already carries `sourceId` and `sourceUrl`
  meaning the individual page or message. Two meanings one level apart.
- `Workspace` collides worse, and on the first two providers. Slack calls the
  whole organization a workspace, so a Workspace would select channels from a
  Connection that *is* a workspace; Confluence has "space" one letter away.
- `Dataset` implies something static, where this is continuously reconciled.

`Connection` returns to its ordinary meaning: an authenticated route to a
system.

## Consequences

**Configuration collapses to what actually differs.** One `Connection` per
workspace; a `Corpus` is a scope and a role list. Rotating a credential touches
one object.

**Two renames ripple.** `Connection` means something different than it did
yesterday, and every existing reference — ADRs, samples, the broker's registry,
`connectionRefs` on `KnowledgeBase`, the `conn:<name>/get` tool id — now names
the wrong tier. This is the main cost, and it is churn rather than risk: the
compiler and the CEL rules catch most of it, and the semantics of each piece
are unchanged.

**One driver-interface change.** `parseWebhook` loses its scope argument and
gains a scope key in its return. Small, but it is the only part of ADR 0038's
driver contract this reopens, and the three existing implementations move with
it.

**A third CRD.** More machinery, one more reconciler, one more thing to explain.
Justified only because the middle tier is load-bearing for access control, sync
bounds and collection identity — not because three tiers are tidier than two.

**The `KnowledgeBase` is untouched.** It composes the same objects under a new
name, keeps union-to-invoke (0039 §4) and keeps being indexed as a generated
Skill.

**Per-user authorization is untouched.** 0040's probe asks the source about a
resource with the caller's own token; which resource came from which tier does
not enter into it.

## Alternatives considered

**Leave it alone and share one Secret.** Ten `Connection`s can already reference
one Secret today; the duplication is then roughly six lines of YAML each. This
is genuinely cheap, and it is the right answer if channel counts stay small. It
was rejected because the mis-naming stays, and because the repeated address and
provider fields are the kind of thing that drifts between copies.

**Two tiers, with the KnowledgeBase selecting.** Rejected in §2: it has nowhere
coherent to put roles.

**Two tiers, with a `scopeKey` payload filter.** `Connection` holds credentials
and an ingest bound, the whole bound is indexed into one collection, each chunk
carries a `scopeKey`, and a knowledge base filters on it at query time. This
works and needs no third CRD, but it ingests material no knowledge base asked
for — including channels nobody intended to index — and puts the selection back
into the view, with the same role problem one step removed.

## Rollout

1. Land this ADR before moving code, since the split is easier to review as
   reasoning than as a rename diff.
2. Add the `Connection` CRD in its new meaning alongside the existing one.
3. Rename the existing `Connection` to `Corpus`, replacing its inline provider,
   address and `secretEnv` with `connectionRef`.
4. Update `KnowledgeBase.spec.connectionRefs` to `corpusRefs`, and the derived
   tool ids that embed the tier's name.
5. Move webhook routing to the broker: `parseWebhook` reports a scope key, and
   a delivery fans out to every matching `Corpus` (§4). Until this lands,
   webhooks reach one subset only and a second `Corpus` on the same
   `Connection` is kept current by its reconcile interval alone — correct, and
   slower than it should be.
6. Update ADRs 0038 and 0039 to point here for the tier they describe.

Superseding is partial and deliberate: 0038's driver interface, webhook policy
and broker execution model stand unchanged, and 0039's composition, access and
indexing rules stand unchanged. What this supersedes is only where the
credential lives and what the middle tier is called.
