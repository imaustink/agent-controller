# 0043. `Connection`, `Corpus`, `KnowledgeBase`: credentials, selection, composition

Status: proposed

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

Everything that hangs off it is therefore unchanged: the provider driver
interface (§1 of 0038), the scope check that refuses a resource outside the
subset, per-subset collections and the fan-out that merges them
(§1 of 0039), per-point roles written at ingest, and the per-user probe
(0040). None of that is reopened here.

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

### 4. Naming

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
5. Update ADRs 0038 and 0039 to point here for the tier they describe.

Superseding is partial and deliberate: 0038's driver interface, webhook policy
and broker execution model stand unchanged, and 0039's composition, access and
indexing rules stand unchanged. What this supersedes is only where the
credential lives and what the middle tier is called.
