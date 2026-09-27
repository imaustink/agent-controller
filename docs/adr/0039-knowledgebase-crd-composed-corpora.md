# 0039. `KnowledgeBase`: composing Corpora into a corpus the agent can query

Status: partly superseded by [0043](0043-connection-corpus-knowledgebase.md)

> **Members are now `Corpus` resources, not `Connection`s,** and
> `spec.connectionRefs` is `spec.corpusRefs`. ADR 0043 moved the credential and
> the address onto a separate `Connection`; the member tier — the thing with a
> scope, a role list and one vector collection — kept every property this
> document gives it and changed only its name.
>
> §1's per-member collections, §4's union-to-invoke, and §5's disambiguation
> all stand as written.

## Context

[ADR 0038](0038-connection-crd-scoped-external-resources.md) makes one scoped
subset of an external system — a Confluence space, a Slack channel, a Drive
folder — into a `Connection` that stays in sync. That is deliberately one
source. What people ask questions against is a **client engagement**, which
spans several: for GLOBEX, a Confluence space, a Drive folder, and *two* Slack
channels.

The composition is many-to-many and expected to churn:

- one knowledge base draws on **several Connections**, including more than one
  of the same provider;
- one Connection may belong to **several knowledge bases** (a shared
  `#platform-announcements` channel is context for every client);
- membership changes as engagements start, merge and end.

There is no corpus retrieval at all today. The orchestrator does role-filtered
vector retrieval over *catalog* collections (`tools`/`skills`/`agents`) via
`vectorstore.Store`, but nothing puts ordinary documents in front of the agent.

## Decision

A **`KnowledgeBase`** is a named, RBAC-gated composition of Connections, and it
is what the agent queries.

```yaml
apiVersion: core.controller-agent.dev/v1alpha1
kind: KnowledgeBase
metadata:
  name: globex
spec:
  displayName: "GLOBEX"
  # Embedded for retrieval. This is SUBJECT MATTER, not a tool contract (§2),
  # and it is what the planner tells twenty client knowledge bases apart by.
  description: >-
    The GLOBEX client engagement: platform migration work, their Confluence space,
    the #globex-eng and #globex-general Slack channels, and the shared delivery
    folder. Covers architecture decisions, meeting notes, and delivery status.
  aliases: ["Southern National", "GLOBEX migration", "Project Harbor"]

  # No allowedRoles: like a Skill (ADR 0011), a KnowledgeBase carries no RBAC
  # of its own — its audience is derived from its members, by union (§4).

  connectionRefs:
    - globex-confluence
    - globex-slack-eng
    - globex-slack-general
    - globex-drive
    - platform-announcements      # shared across several knowledge bases

  chunk: { maxTokens: 800, overlap: 100 }

status:
  documents: 5312
  perConnection:
    - { name: globex-slack-eng, documents: 4120, lastSyncTime: "..." }
  staleConnections: ["globex-drive"]
  conditions: [...]
```

### 1. Embeddings live with the Connection, not the KnowledgeBase

**One Qdrant collection per `Connection`.** A `KnowledgeBase` query fans out
across its members' collections in parallel and merges the hits.

This inverts an earlier draft, which gave each corpus its own collection, and
the composability requirement is what forces it. If points live in a per-KB
collection, adding `platform-announcements` to a fifth knowledge base re-embeds
that channel a fifth time, and every membership change triggers a re-index.
With embeddings owned by the Connection, **composing and recomposing a
knowledge base is a metadata change costing nothing** — which is the point of
making composition declarative at all.

The rest follows: a Connection deleted is a collection dropped; a Connection
shared by six knowledge bases is embedded once; sync status is per-Connection
because storage is per-Connection.

The cost is a fan-out — N parallel `Query` calls, top-k each, merged by score
and pruned to K overall. Scores are comparable because every collection uses
the same embedder and cosine distance. At realistic sizes (2–8 Connections) this
is a handful of concurrent round trips to a service the orchestrator already
dials, not a new performance model. Documents reachable through two Connections
are de-duplicated at merge by content hash, keeping first-seen provenance.

Isolation reasoning only gets finer: one collection per Connection, never one
shared collection with a tenant filter. The failure modes are not symmetric — a
filter bug leaks one client's material into another client's answers, while a
wrong collection name returns nothing.

### 2. A KnowledgeBase is a generated Skill

The indexer derives a **`SkillDescriptor`** from each KnowledgeBase: generated
markdown, and `toolRefs` covering its own `kb:<name>/search` and
`kb:<name>/fetch` plus each member Connection's `conn:<name>/get` (ADR 0038 §5).

This is not a new selection mechanism — it is the one that already exists.
`agentloop.go:298-301` builds the planner's `planCandidates` from the *selected*
skill's resolved tools, so tools belonging to unselected skills never enter the
prompt. Making a KnowledgeBase a Skill therefore gives, for free, the property
that matters: **a knowledge base's tools exist only once the agent has chosen
that knowledge base.**

Two consequences follow, and the second is the more valuable:

- **What competes in retrieval is subject matter, not tool contracts.** Twenty
  generated `kb:<client>/search` tools in the global catalog would be twenty
  near-identical descriptions of how to call a search function — boilerplate is
  exactly what makes embeddings collide. Twenty KnowledgeBase descriptions are
  about engagements, systems and codenames, which discriminate.
- **Client API access becomes least-privilege by construction.** A scoped GET
  tool for one client's Confluence space has no business being globally
  selectable. At twenty clients and five Connections each, that is 100 scoped
  API tools in the catalog — a retrieval problem *and* a blast-radius problem.
  Gating them behind the knowledge base solves both in one move.

The generated markdown carries the reading discipline: answer only from
retrieved chunks, always cite, disclose partial visibility (§4) and staleness,
and treat chunk text as untrusted data rather than instructions.

A KnowledgeBase is not modelled as a fourth selectable kind in `selectDelegate`.
Reusing `Skill` keeps one selection path, and matches how this repo has grown —
ADR 0021 added `agentRefs` rather than a new dispatch, ADR 0037 made Tools
compete in the existing selection rather than building a parallel one.

### 3. Two generated tools, plus the live face

- **`kb:<name>/search`** — semantic search across member Connections. An
  optional `connections: [...]` argument narrows to specific members ("what did
  #globex-eng say about the migration"), which is why same-provider repeats need
  distinct `displayName`s. Returns chunks with `sourceUrl`, originating
  Connection and `updatedAt`.
- **`kb:<name>/fetch`** — the full document behind a chunk. A chunk is
  frequently not enough to answer from, and re-searching to see more of the same
  page is a poor substitute for reading it.

Generated tools rather than a new retrieval stage means **citations work for
free**: composition (ADR 0015) frames "the verbatim result of the last
successful tool call," so a search tool returning Markdown chunks with their
source URLs produces a cited answer through the path that already exists.

ADR 0038 §5's `conn:<name>/get` complements this: search finds the page as of
the last sync, the GET face reads its current state. Retrieval for recall, the
API for freshness.

### 4. Access: union to invoke, per-point to read — a documented ADR 0011 exception

> **Superseded in part by [ADR 0040](0040-per-user-delegated-authorization-for-knowledge-base-retrieval.md).**
> Per-point roles remain as a coarse pre-filter, but they are no longer the
> authorization decision: a candidate is authorized by hydrating it live against
> the source with the user's own delegated token. Citations must then come from
> the hydrated response rather than from chunk metadata, since a title or URL
> leaks as surely as a passage does. The union-to-invoke rule below is
> unaffected.

`DeriveSkillAccess` (`engines/temporal/internal/catalog/derive.go:11-39`,
mirrored in `apps/agent-orchestrator/src/skills/derive-access.ts`) computes a
Skill's audience as the **intersection** of its refs' roles: "visible iff the
caller can use EVERY tool the skill declares." Applied unchanged to a generated
KB-skill, one restricted Slack Connection would make an entire client knowledge
base invisible to everyone else.

So a KB-derived skill takes the **union** of its Connections' roles instead.
This is a deliberate exception to ADR 0011, and both implementations need the
branch — it must be written as an exception, not arrived at by accident.

The union governs *invocation*. Visibility is enforced per chunk by machinery
that already exists: `vectorstore.Record` carries per-record `Roles` and
`Store.Query` filters on them fail-closed (`vectorstore/store.go:22-45`). Each
point is written with the `allowedRoles` of the Connection that produced it.

This leaves one honesty problem that must be handled rather than ignored. A
caller who cannot see a restricted Connection gets an answer from a **partial**
corpus, and neither they nor the agent can distinguish "nothing exists about
this" from "nothing you may see exists about this." So `kb:<name>/search`
returns the count of role-excluded Connections, and the generated markdown says
so plainly ("2 sources in this knowledge base are outside your access"). That is
minor metadata disclosure, so it is suppressible per knowledge base — but
silence is the worse default, because a confidently wrong "there's nothing about
that" is the failure a knowledge base exists to prevent.

### 5. Choosing between knowledge bases: ask

Twenty knowledge bases will produce vague queries that plausibly match several —
"what's the status of the migration?" names no client. Three mechanisms handle
this, in order of how often they apply:

1. **Continuity.** ADR 0012's session-scoped active skill means a thread stays
   on the knowledge base it started on, with the topic-change judge handling a
   genuine switch. Selection is therefore semantic only on the *first* turn of a
   thread, and contextual thereafter. This is the largest win, and it exists
   only because a KnowledgeBase is a Skill (§2).
2. **Ask.** When several knowledge bases remain plausible, the agent asks which
   one rather than guessing. Candidates come from role-filtered retrieval, so
   the offered list never names a knowledge base the caller cannot see. This is
   a good question to put to a human precisely because §2 made the choice one
   between *subjects* — "GLOBEX or Acme?" is answerable in a way "`kb:globex/search`
   or `kb:acme/search`?" never was.
3. **Discriminating text.** `spec.description` and `spec.aliases` carry the
   client's real name, project codenames, systems involved, and what people
   actually call it. Both are embedded.

Asking costs a turn, and continuity means it is paid roughly once per thread
rather than once per question. Treating ambiguity as a question rather than a
ranking failure is what keeps knowledge-base count from being a scaling limit;
an earlier draft proposed a single search tool with a caller-filtered enum
argument as the escape hatch at ~20 knowledge bases, and that is no longer
needed.

Ambiguous-selection-asks-the-user is a general capability, not a
knowledge-base one. It is scoped here to knowledge bases; generalizing it to
any close candidate set belongs in its own ADR.

### 6. Chunking is the quality bottleneck, and it belongs to the driver

`spec.chunk` sets defaults that each ADR 0038 driver overrides, because these
corpora do not chunk alike. A Confluence page is prose and chunks by heading. A
Slack channel is thousands of short, interleaved, thread-nested messages where
fixed-window chunking produces retrieval slop; it wants thread-aware grouping
with author and timestamp preserved in the chunk text. A Drive folder is
whatever people put in it.

Stated plainly because it is the part most likely to be underestimated: **chunk
quality, not CRD design, determines whether the answers are any good.** No
amount of Kubernetes modelling substitutes for it, and it is where the effort
will actually go.

### 7. Content-hash point ids

A point's id is a sha256 over its normalized chunk text plus source id — the
trick ADR 0035 uses to make caller-tool embedding "paid on first sight of a
definition, not per request." A reconcile re-embeds only what changed.

Load-bearing rather than an optimization: re-embedding a Confluence space every
reconcile is the reason a sync like this gets switched off a week after it
ships. It also means the diff *is* the store, retiring the sync-state-document
bookkeeping the original knowledge-base plan invented.

## Consequences

**Composition is free; ingestion is not.** A new knowledge base over existing
Connections costs one CR and no embedding. A new *source* still costs a
backfill.

**One knowledge base per turn, for now.** Skills are singular per turn, so
"compare how we handled auth for GLOBEX and Acme" cannot span two knowledge bases.
Today the explicit answer is that this is a knowledge base too — compose the
cross-client Connections deliberately, which is better than implicit
cross-client retrieval anyway.

Lifting that limit means letting a turn acquire capabilities mid-loop rather
than selecting one delegate up front — a change to ADR 0008's turn model that
deserves its own ADR. **This design does not depend on it**: it works under
single selection today and strictly improves under multi-selection later.
Worth recording now, because it is the reassuring part: per-point RBAC is
enforced at the store rather than at selection (§4), so loading two knowledge
bases in one turn would not create a cross-client leak. The singular-skill
constraint is not what makes tenancy safe here, which is why relaxing it is
safe.

**The sharper limit is a knowledge base plus a *procedure*.** Two knowledge
bases in one turn has a deliberate answer above; "follow the deploy runbook and
check the client's Confluence" does not. Knowledge is orthogonal to procedure,
and modelling it as a skill makes the two compete for a slot that only one can
hold. Selection is also per turn, so a knowledge base the conversation has been
using is re-won from scratch each turn and silently lost on any turn that picks
a procedure — which is not how a person uses a knowledge base.

The fix is to stop modelling knowledge as a skill: make KnowledgeBase a
first-class object retrieved *alongside* skill selection and attached without
consuming the slot. We are not doing that here. It trades away the two
properties §2 buys for free — subject matter competing instead of tool
contracts, and scoped API tools staying out of the global catalog — so a
replacement has to re-earn both, and doing that before the mid-loop acquisition
change lands means guessing how the two interact. Revisit when it does.

**`vectorstore.Collections` becomes dynamic.** It goes from a fixed three-field
struct to a fixed catalog plus a per-Connection registry. Contained —
`NewQdrant` is already parameterized by collection name and `EnsureCollection`
creates missing collections — but collection lifecycle is new: creation on
Connection admission, drop on deletion, and an orphan sweep, taking care that a
Connection removed from one knowledge base is not dropped while another still
references it.

**Both engines must derive the same skill.** ADR 0036 left two implementations
of the agent loop, and a knowledge base has to behave identically whichever one
serves the turn — so the derivation, the union-access rule and the fan-out exist
twice, in `engines/temporal/internal/{catalog,corpus}` and
`apps/agent-orchestrator/src/knowledge-base`. The generated markdown is the part
that matters most and the part most likely to drift, because it is **prompt
material**: a phrase added on one side and not the other means the same
knowledge base cites differently, or stops disclosing withheld sources, purely
depending on `AGENT_ENGINE`. Each side carries a PARITY comment naming its twin,
and both test suites assert the same load-bearing phrases. A shared fixture
would be better and there is no obvious home for one across Go and TypeScript.

**Skill retrieval now carries knowledge bases.** Generated KB-skills share the
`skills` collection with authored ones. That collection is the designed choke
point for "what is this turn about," so it is the right home — but skill count
now grows with client count, and `scheduleSkillReindex`'s debounced
re-derivation (ADR 0020) runs over a larger set.

**Embedding-model changes become a migration.** Every Connection collection is
built with one embedder at one dimensionality; changing models means re-indexing
everything, with no story yet beyond "rebuild." `spec.embedding` carrying model
and dims would at least make the mismatch detectable rather than silently wrong.

**Retrieved chunks are untrusted input, at a new scale.** Anyone who can post in
a synced client channel can write into a corpus that reaches an LLM prompt
verbatim — `security.md`'s hostile-text model, now continuously fed by
outsiders. Chunks belong in a distinctly-labeled untrusted block, the same
treatment caller-tool definitions get (ADR 0035 §4).

**Open WebUI stops being the storage layer**, retiring the `splitMessages`
system-message problem (ADR 0038 Context) — retrieval no longer depends on Open
WebUI injecting anything. It returns to being a chat UI.

**Non-engineers lose drag-and-drop upload.** Open WebUI's knowledge-base UI is
how somebody adds a one-off PDF; behind CRs that becomes a pull request. A
`manual` Connection provider — an authenticated upload endpoint writing into its
own collection — is the escape hatch, required before this replaces Open WebUI's
knowledge bases for real users rather than for us.

## Alternatives considered

**A fourth selectable kind in `selectDelegate`.** Explicit, and avoids
overloading `Skill`. Rejected: Skill selection already scopes tools exactly as
needed (§2), and a parallel selection path is the thing ADRs 0021 and 0037 both
declined to build.

**Per-KB generated search tools in the global catalog.** Simplest to implement.
Rejected: twenty near-identical tool descriptions compete badly, and it puts
every client's scoped API tool in front of every caller.

**A single search tool with a caller-filtered knowledge-base enum.** Moves
selection from embedding similarity to an explicit argument, and was the earlier
draft's answer at ~20 knowledge bases. Rejected: it trades retrieval-time RBAC
(free today) for call-time RBAC (new code), and asking the user (§5) addresses
the same ambiguity without giving that up.

**One collection per KnowledgeBase.** One query instead of a fan-out. Rejected:
duplicates embeddings for shared Connections and turns every membership change
into a re-index, defeating the composability this ADR exists to provide.

**One collection for everything, with a tenant payload filter.** Fewest
collections. Rejected on failure-mode asymmetry (§1).

**Intersection RBAC, per ADR 0011 unchanged.** Consistent with precedent.
Rejected: one restricted member would hide an entire client knowledge base, and
per-point filtering already gives a correct, finer answer (§4).

**Membership by label selector** rather than explicit `connectionRefs`. More
idiomatic and self-maintaining. Rejected for now: which sources compose a
client's knowledge base is worth reviewing in a diff, and a mistyped selector
silently widening a client boundary is a bad failure mode.

## Rollout

1. `KnowledgeBase` CRD + reconciler; dynamic per-Connection collections.
2. Indexer: driver documents → chunks → content-hash upsert with per-point
   roles; KB → `SkillDescriptor` derivation with union access.
3. `kb:<name>/search` + `kb:<name>/fetch`, with fan-out, merge, de-duplication
   and the excluded-sources count.
4. Generated skill markdown: cite always, disclose partial visibility and
   staleness, treat chunks as untrusted, ask when the client is ambiguous.
5. **First end-to-end target:** one KnowledgeBase over a Confluence Connection
   answering client questions with citations — then add the two Slack channels,
   which is what proves composition and same-provider repeats.

Deferred: multi-delegate turns; generalized ambiguous-selection asking; a
`manual` upload provider; embedding-model migration.
