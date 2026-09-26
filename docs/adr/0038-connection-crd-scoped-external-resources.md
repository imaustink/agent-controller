# 0038. `Connection`: a scoped subset of an external system, kept in sync and callable

Status: partly superseded by [0043](0043-connection-corpus-knowledgebase.md)

> **The tier this ADR calls a `Connection` is now a `Corpus`.** ADR 0043 split
> the credential and the address out into a resource that kept the name
> `Connection`, so wherever this document says "a Connection" and means one
> space, one channel or one folder, read "a Corpus".
>
> Everything else here stands unchanged: the provider-driver interface, the
> scope check, reconcile-as-source-of-truth, the GET face and the broker
> execution model. The one exception is §4's webhook handling — a delivery now
> arrives per Connection and fans out to the Corpora over it, and the driver
> reports which subset changed rather than being handed one (0043 §4).

## Context

Every capability the agent has today is code we wrote. A `Tool` (ADR 0010) is a
prebuilt image the controller runs as a Job; a `LocalTool` (ADR 0014) is a
pinned package a sidecar runs in-pod. Neither models the case that keeps
recurring: **a bounded set of resources inside a third-party system that the
agent should be able to read, search, and stay current with.**

Scoping a per-client knowledge base surfaced the pattern three times over, and
the three instances are the same shape:

| System | The resources | The scope |
| ------ | ------------- | --------- |
| Confluence | pages | a space |
| Slack | messages | a channel |
| Google Drive | files | a folder |

Each has a list operation, a fetch operation, a change notification, and a
credential. Each needs incremental sync rather than a full re-read. Each
belongs to exactly one client engagement, and several of them — including
**two of the same kind**, such as `#snc-eng` and `#snc-general` — have to
compose into one thing the agent can query.

Writing three bespoke ingestion tools (the first draft of
`docs/knowledge-base-sync.md`) would produce three images that each
re-implement pagination, incremental diffing, credential wiring, webhook
verification, chunking and embedding. The differences between Confluence and
Slack amount to perhaps 150 lines each; everything else is shared.

Two further gaps made the current model a poor fit:

- **Credentials attach to the wrong noun.** `Tool.spec.identityProviders`
  (ADR 0032) binds a credential to one tool, but one Atlassian OAuth app backs
  every Confluence and Jira operation, and one Slack bot token backs every
  channel.
- **Retrieval has no corpus.** The orchestrator does role-filtered vector
  retrieval over *catalog* collections only. The first draft therefore reached
  for Open WebUI's RAG, whose retrieved context arrives as a **system** message
  that `splitMessages` (`engines/temporal/internal/gateway/server.go:410-441`)
  discards outright — attaching a knowledge base there and asking a question
  silently retrieves nothing.

This ADR covers the connection half. Composition into a queryable corpus is
[ADR 0039](0039-knowledgebase-crd-composed-corpora.md).

## Decision

A **`Connection`** is one **scoped subset of resources in one external system**,
plus the credential that reaches it. Not "a Slack integration" — *this channel*.
Not "Confluence" — *this space*. Several Connections of the same provider are
ordinary and expected.

```yaml
apiVersion: core.controller-agent.dev/v1alpha1
kind: Connection
metadata:
  name: snc-slack-eng
spec:
  provider: slack                 # confluence | slack | gdrive  (driver enum)
  displayName: "#snc-eng"         # what citations render
  allowedRoles: [reader, writer]

  scope:                          # provider-validated; the security boundary
    channel: C6RQKL5BK

  secretEnv:
    - name: SLACK_BOT_TOKEN
      secretRef: { name: slack-bitovi, key: token }

  sync:
    mode: webhook                 # webhook | poll | none
    reconcileInterval: 6h         # ALWAYS set — webhooks are lossy (§4)
    backfill: { since: "2026-01-01" }

  api:                            # the live face (§5) — optional
    enabled: true
    methods: [GET]

status:
  resources: 4120
  lastSyncTime: "2026-09-19T04:00:00Z"
  lastReconcileTime: "2026-09-19T00:00:00Z"
  webhook: { registered: true, expiresAt: "2026-09-26T00:00:00Z" }
  conditions: [...]
```

Two Slack channels are two Connections pointing at the same Secret. The
duplication is three lines of YAML; normalizing it into a separate
credential-holding resource would buy little and cost a second CRD and a join.

### 1. Provider drivers are the generalization

The shared machinery lives in one place and each provider implements a narrow
interface:

```go
type Provider interface {
    ValidateScope(scope Scope) error

    // Incremental listing. `since` is the driver's own cursor from the last
    // run (a Slack ts, a Confluence version, a Drive changes-token), opaque
    // to everything above.
    List(ctx context.Context, scope Scope, since Cursor) ([]ResourceRef, Cursor, error)

    // One resource, normalized: Markdown body + sourceURL + updatedAt +
    // provenance. Normalization is the driver's job; nothing downstream knows
    // what a Slack thread or a Confluence storage-format page looks like.
    Fetch(ctx context.Context, scope Scope, id string) (Document, error)

    // Change notification: how to register, how to verify a payload, and how
    // to turn one into the ids that went stale.
    Webhook() WebhookSpec
    ParseWebhook(payload []byte) ([]ResourceRef, error)

    // The GET allowlist and, critically, how to prove a request stays inside
    // `scope` (§5).
    API() APISpec
}
```

Adding Jira, Notion, Linear or GitHub Discussions later is an implementation of
this interface — not a container, a chart template, a credential pattern and a
sync loop. Pagination, incremental diffing, chunking, embedding, RBAC, webhook
plumbing, retries and status reporting are written once.

### 2. This is a deliberate step back from MCP-as-everything

An earlier draft of this ADR made MCP the primary mechanism and derived the
tool surface from `tools/list`. That was wrong for the sync face, and the
reasons are worth recording:

- MCP tools give no **incremental** contract. There is no "changed since" in a
  generic `getPagesInSpace`, so every sync is a full re-read.
- There is no **change notification** a vendor tool surface exposes. Webhooks
  live outside MCP entirely.
- There is no **scope enforcement**. A generic tool takes whatever arguments
  the planner produces; nothing structurally prevents reading a page outside
  the space this Connection is scoped to.
- Mapping one vendor's idiosyncratic tool names onto list/fetch requires
  per-server configuration — which is a driver, written in YAML instead of Go,
  with worse types and no tests.

MCP keeps two real roles, neither load-bearing here. A Connection may
additionally point at an MCP server to expose richer **live** operations beyond
the GET face (§5), and a server implementing MCP's `resources/list` +
`resources/read` + `resources/subscribe` primitives — which *are* designed for
exactly this — can back a generic driver. Native drivers are what will ship for
Confluence, Slack and Drive; `provider: mcp` is deferred to its own ADR rather
than pretended into this one.

### 3. Execution: a `connection-broker` Deployment

Drivers run in a new long-lived `connection-broker` Deployment — **not** the
orchestrator pod, **not** a per-call Job.

ADR 0014 rejected in-orchestrator execution because it would run "in the
orchestrator's own process/pod with its secrets and k8s identity in reach." The
same reasoning applies with the noun changed from *code* to *credentials and
egress*: a broker holding every client's Slack, Atlassian and Google
credentials does not belong in the pod holding cluster RBAC.

A per-call Job was rejected for the live face (pod scheduling latency on every
read, and a fresh session per call) and is wrong for sync (a driver holds
cursors and rate-limit state across a run). The broker is network-reachable
in-cluster exactly like Qdrant and NATS, which the orchestrator already dials,
and it serves both the orchestrator and sync workers — something a unix socket
in the orchestrator pod (LocalTool's transport) could not.

It exposes:

- `POST /connections/:name/sync` — run or resume a sync.
- `GET  /connections/:name/resources` — the paginated bulk read ADR 0039's
  indexer consumes.
- `GET  /connections/:name/api/*` — the scope-enforced GET face (§5).

The broker is a confused deputy by construction: it holds every credential and
makes outbound calls for whoever asks. It must authenticate callers (the
orchestrator vs. a specific sync Job) and authorize per connection. That is the
largest piece of new security work in this ADR, and it is not optional.

### 4. Webhooks are an optimization over reconciliation, never a replacement

`sync.mode: webhook` still requires `reconcileInterval`. Every one of these
notification channels is lossy in normal operation:

- Google Drive push channels **expire** (~1 week) and must be re-registered;
  a missed renewal silently stops delivery.
- Slack's Events API drops events during outages and offers no replay.
- Confluence webhooks can be disabled by a space admin without telling us.

So the design is: **the full reconcile is the source of truth; webhooks only
make it faster.** A corpus that can only be correct if every webhook arrived is
a corpus that is quietly wrong. Correctness is defined by "what a reconcile
from scratch would produce," which also gives a clean answer for deletions —
a page removed in Confluence leaves the corpus at the next reconcile even if
its delete event was never delivered.

Webhooks land in **integration-gateway**, which already owns "all
channel-specific concerns" (`docs/integrations-gateway.md`) and already has
`src/webhooks/github.ts`; Slack is listed there as proposed-but-unimplemented.
They need one new output shape: today the gateway turns an event into an agent
turn, whereas a sync webhook must instead **mark resource ids dirty**.

Dirty ids are coalesced, not acted on individually. A busy Slack channel
produces a continuous event stream, and one sync per message would mean one
embedding call per message. Events accumulate into a per-Connection dirty set
flushed on a debounce window (default 60s), so a burst of 200 messages costs
one targeted fetch of 200 ids, not 200 syncs.

### 5. The live face: GET-only, allowlisted, and scope-enforced

Retrieval returns a chunk of what was true at the last sync. Often the agent
needs the **live** object — the current page version, the current thread, the
file's present sharing state. So a Connection with `api.enabled` generates a
catalog tool `conn:<name>/get`, subject to three limits:

1. **GET only** in v1alpha1. Writes need an authorization story this ADR does
   not attempt; `methods` exists so that story has somewhere to land.
2. **A driver-declared path allowlist.** The provider names which endpoints are
   exposable — not free-form URL construction by a planner.
3. **Scope enforcement.** The driver validates that the request stays inside
   `spec.scope`: a `snc-confluence` Connection cannot read a page in another
   space, whatever arguments the planner produces.

Point 3 is only possible because drivers are typed, and it is the strongest
argument against the generic HTTP passthrough an earlier draft proposed. A
passthrough with a credential is an unbounded capability wearing an allowlist;
a scoped driver is a bounded one.

`allowedRoles` on the Connection gates the generated tool exactly as it gates
any other catalog entry — its OWN roles, not the union of whatever knowledge
base includes it, since this is one source's capability rather than the
composition's.

The generated tool is also indexed **hidden**: reachable because the knowledge
base that includes it declared it by id, never returned by open retrieval
(ADR 0039 §2). Twenty clients' scoped GET tools competing in the global catalog
would be both a retrieval problem and a blast-radius one.

[ADR 0040](0040-per-user-delegated-authorization-for-knowledge-base-retrieval.md)
amends this section: the GET face carries the **calling user's** delegated
token, not the connection's service credential. Otherwise the model's own
follow-up read becomes the way around that ADR's authorization probe.

### 6. Sync runs as a controller-owned CronJob

`spec.sync.reconcileInterval` causes core-controller to reconcile a CronJob for
that Connection's reconcile pass; the debounced webhook flush runs in the
broker. The controller already builds Jobs from CRs and owns secret injection,
so this is an extension of existing behavior rather than a new subsystem.

Deliberately not a general scheduling feature. If scheduled agent work is
wanted beyond connection sync, it earns its own CRD and its own ADR.

One unresolved detail, surfaced while implementing the CRD: a `Duration` does
not convert cleanly to a cron expression. `6h` becomes `0 */6 * * *`, but `7m`
has no faithful equivalent — `*/7` fires at :00 through :56 and then leaves a
four-minute gap. Either the field becomes a cron string (idiomatic for
CronJob, less friendly, and no longer says "at most this stale"), or the
controller schedules Jobs itself on `RequeueAfter` (exact intervals, reuses the
existing Job path, but loses scheduling across controller downtime). Deferred
until the sync worker exists, because the choice is easier to judge against a
real job spec than in the abstract.

### 7. Identity attaches to the connection

`Connection.spec.identityProviders` resolves per-user delegated credentials as
ADR 0032 does for tools, but once per *system* rather than once per tool.

v1alpha1 ships the shared-credential path (`secretEnv`) only. A scheduled
reconcile has no calling user, so a per-user sync is incoherent as stated and
needs its own design; shared service credentials for sync, with optional
per-user delegation on the live face, is the likely shape and is deferred.

## Consequences

**Adding a source becomes a driver, not a product.** ~150 lines implementing
`Provider`, plus a CR. The three-tools-that-share-90%-of-their-code outcome the
first draft would have produced is avoided.

**We own the sync semantics.** Cursors, deletion detection, webhook renewal,
rate limits, backoff, partial-failure recovery. This is genuinely the hard part
and it does not disappear by being centralized — it just gets written and
tested once instead of three times, badly.

**The broker concentrates credentials.** A single component holds every
client's third-party tokens and talks to the internet. That is a deliberate
trade against maintaining a dozen API clients, and it argues for a dedicated
ServiceAccount with no cluster RBAC, NetworkPolicy egress limited to configured
hosts, and per-connection rate limiting.

**integration-gateway grows a non-conversational path.** Its existing shape
assumes an event becomes an agent turn. Dirty-marking is a second output kind,
and the debounce/coalesce buffer is new state in a component that currently
holds little.

**Scope is load-bearing for security, so scope validation must be strict.** A
Connection's blast radius is exactly its scope, which makes `ValidateScope` and
the API face's scope check the two functions most worth reviewing carefully. A
driver that accepts an unvalidated scope, or builds a URL by concatenation,
silently widens a client boundary. Shape agreement between `provider` and
`scope` is therefore enforced by CEL on the CRD — rejected at admission, before
any driver sees it — rather than left to the driver at run time.

**The controller does not validate credentials, on purpose.** core-controller
holds no RBAC on Secrets at all: it injects `secretEnv` into a Job by reference
and lets the kubelet resolve it, so no secret value ever enters the controller
process. Confirming that a Connection's referenced Secret exists would mean
granting it read over Secrets cluster-wide — a real privilege increase to buy a
nicer error. A missing credential surfaces as a failed sync instead, and that
trade should be re-argued rather than quietly reversed.

**Two Slack channels duplicate credential wiring.** Accepted; if connection
counts grow into the dozens per client, a credential-holding parent resource is
the obvious normalization and can be added without breaking existing CRs.

## Alternatives considered

**A hand-written container Tool per source** (the first draft). Maximum control,
perfect fit with existing patterns, and the right answer for any one-off
integration. Rejected as the default because three sources already share
almost all of their code and the fourth is a matter of time.

**MCP-derived tool surfaces as the primary mechanism.** Rejected for the sync
face on incrementality, change notification and scope enforcement (§2); retained
as an optional live-face transport and a possible future driver.

**One `Connection` per system, with resource scopes as a list inside it.**
Fewer objects (`slack` with three channels). Rejected: scope is the unit of
access control, of RBAC, of sync state and of knowledge-base membership, so it
wants to be the unit of the resource — and ADR 0039's KnowledgeBase needs to
reference one channel, not "channel 2 of the slack Connection."

**A separate credential resource referenced by Connections.** Normalized and
DRY. Deferred (see Consequences) rather than dismissed; the join is not worth
a second CRD at three-connections-per-client scale.

**Webhook-only sync, no reconcile.** Lower cost and simpler. Rejected outright:
every one of these notification channels is lossy (§4), and a corpus that is
correct only if no event was ever dropped is a corpus nobody can trust.

## Rollout

1. `Connection` CRD + reconciler (scope validation, status, CronJob for
   reconcile passes).
2. `connection-broker` Deployment: driver runtime, caller authn/authz, sync +
   resources + API endpoints.
3. The Confluence driver end to end — backfill, incremental reconcile, GET face.
   First target because a space is the best-behaved of the three.
4. Webhook path in integration-gateway: verification, dirty-marking, debounce.
5. Slack and Drive drivers, including Drive channel renewal.

Deferred: `provider: mcp`; write methods on the API face; per-user
`identityProviders`; a credential-holding parent resource.
