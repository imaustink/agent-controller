# 0034. Linked credentials live in Kubernetes Secrets, not in an ephemeral Redis

Date: 2026-07-26

## Status

Accepted

Amends [0022](0022-per-user-github-device-flow-identity.md) (per-user GitHub
identity), [0027](0027-per-user-claude-oauth-setup-token-delegation.md) (per-user
Claude credentials), and the storage assumption underneath
[0029](0029-canonical-github-credential-subject.md) /
[0031](0031-principal-establishing-account-link.md).

## Context

A triage run asked its user to re-authorize, hours after chat had worked for the
same person. The symptom was identical to the bug ADR 0031 had just fixed, so the
first suspicion was that the convergence work had regressed. It had not. The
turn's own verdict shows the pre-flight doing exactly what 0031 built it to do:

```
[authorization] {"verdict":"link-required","agentId":"claude-code-swe-agent",
                 "pending":["claude@github:imaustink","claude-remote@github:imaustink"]}
```

The principal resolved. Both providers were looked up under
`github:imaustink` — the converged key, in both flows, as designed. There was
simply nothing stored there. Nor anywhere else:

```
$ redis-cli --scan     # agent-orchestrator-redis: the store behind BOTH flows
sessionPage:session:github:imaustink/agent-controller#151
sessionPage:token:vEqpyrHNwXMnqUiLfyS2EQln5qJJuSvdGVpE4nCgwb0
```

Two keys. Every identity link and every Claude credential in the cluster was
gone, because:

- `charts/agent-controller/charts/agent-orchestrator/templates/redis.yaml` runs
  Redis with `--save "" --appendonly no` — no RDB snapshots, no AOF.
- Its only volume is an `emptyDir`.
- The pod terminated (exit 255) and restarted a few hours earlier.

So the store had no durability of any kind: not across a pod restart, not across
a reschedule, not across a node failure. Chat had worked earlier only because the
records were still resident in memory; it would have prompted on its next turn
too. Triage was merely first to ask.

### Why this is a design defect and not a misconfiguration

It is tempting to read this as "someone forgot to enable persistence", fixable
with a PVC and `--appendonly yes`. That would have stopped the bleeding, and it
was rejected as the primary fix for two reasons:

1. **The interface promised what the implementation could not deliver.** Both
   store interfaces are documented as *durable*, and both explicitly note that
   they set **no TTL** because "an account link persists until the user
   re-links". The only implementations of those interfaces were backed by a cache
   configured to lose everything on restart. Nothing in the type system, the
   tests, or the deployment connected the promise to the thing that had to be
   true for it to hold.

2. **A cache and a credential want opposite defaults.** Conversation sessions and
   session pages *should* be cheap, evictable, and TTL'd; an OAuth credential a
   human created by hand should be none of those. Storing both in one Redis meant
   one persistence setting had to serve both, and whichever way it was set, it
   was wrong for half of its contents. Making that Redis durable would fix the
   credentials by making the cache heavier, rather than by putting each kind of
   state where it belongs.

## Decision

**Linked credentials move to Kubernetes Secrets. Redis keeps only the
cache-shaped state.**

Three record types move: GitHub identity links (`identity-link/`), per-user
Claude credentials of both kinds (`claude-auth/`, `setup-token` and `login`), and
the per-run credential write-back grants. Conversation sessions and session pages
stay in Redis, which is now used only for state whose loss costs a conversation.

Both store interfaces are unchanged — `IdentityLinkStore` and
`ClaudeTokenStore` are implemented as written, so nothing downstream of them
(the pre-flight, `rekey`, the gateway's HTTP API) needed to change. What changed
is the thing that was lying about being durable.

### Why Secrets rather than a database

A Postgres would be the conventional answer, and was considered. It was rejected
on cost, not on fit: `agent-controller` has no Postgres of its own (the
`agent-controller-openwebui-postgres` cluster in the same namespace belongs to
the openwebui release), so this would mean introducing a new stateful component
— a subchart, a PVC, a schema and migrations, a backup story, a new `pg`
dependency — to store what amounts to a handful of small blobs keyed by a string.
Reusing openwebui's cluster was rejected outright: it would couple this
controller's credential durability to another release's lifecycle.

Secrets are already the platform's answer to "durable, namespaced, small,
secret, backed up with the cluster". `@kubernetes/client-node` was already a
dependency of the monorepo, and the gateway already had a ServiceAccount to
attach a Role to.

### What Secrets do not provide, and what we do about it

- **Confidentiality is not delegated to etcd.** Encryption-at-rest is a cluster
  opt-in, and an etcd backup without it is a plaintext copy of every Secret. The
  existing AES-256-GCM field encryption (under the same
  `IDENTITY_LINK_ENCRYPTION_KEY`, no new secret to provision) is kept exactly as
  it was, so the durable copy is ciphertext and durability stays independent of
  confidentiality. Reading the namespace yields no usable tokens.
- **Object names are not arbitrary strings.** Record keys are things like
  `openwebui:1234` and long IdP `sub`s; a colon is illegal in a DNS-1123 name and
  the length is unbounded. Names are therefore `<prefix>-<sha256(key)[:16]>`,
  which keeps every read an exact `get` (no listing, no scan) at the cost of a
  name that no longer identifies its owner — so the plaintext key is stored in
  the record and mirrored onto a label for `kubectl get -l`.
- **There is no TTL.** This is a feature for links (they should persist) and a
  gap for write-back grants (they should not). See below.
- **There is no pub/sub.** The Redis `waitForCompletion` — what lets a chat turn
  resume the instant a user finishes linking in their browser — becomes a `watch`
  by object name, *plus* an unconditional slow poll. Both, not a fallback branch:
  the watch makes the common case immediate, the poll bounds the damage from a
  watch that never established or silently died, and "try watch, catch, else
  poll" only handles the failures that announce themselves.

### Write-back grants are collected by their AgentRun

Grants are the one record with a lifetime (a run's duration plus 15 minutes), and
Kubernetes has no TTL on a Secret. Rather than add a GC loop, they join a
mechanism that already exists: `agentrun-launcher.ts` was already creating a
per-run identity Secret *before* the AgentRun CR existed and then patching an
`ownerReference` onto it once the CR had a uid, and
`agentrun_controller.go`'s retention pass already reclaims a terminal AgentRun
"and the Secret it owns". So the gateway returns the grant's object name from the
mint route, and the launcher adopts it exactly like its own.

Expiry is still enforced on read, independently. Ownership decides when the
*object* is collected; `expiresAt` decides when the *grant* stops authorizing.
A launch that failed after minting, or a run not yet swept, must not leave a
working grant behind.

### No dual-path, and no migration

The Redis implementations are deleted rather than kept behind a flag. Keeping
both would double the config surface and let a deployment silently select the
ephemeral backend — which is precisely the failure being fixed. There is nothing
to migrate: the store was empty when this was written, which is the one moment a
cutover is free.

## Consequences

- A Redis restart, reschedule, or node loss now costs at most a conversation.
  Nobody is asked to re-authorize by infrastructure.
- `AGENT_REDIS_URL` is no longer required to enable identity-link, and is no
  longer part of that feature's partial-configuration startup gate. Redis remains
  required only for session pages.
- The gateway now needs a Kubernetes identity where it previously needed none:
  a namespace-scoped Role granting `secrets` CRUD, rendered only when
  identity-link is enabled, with the ServiceAccount token mounted only then. A
  deployment that merely relays issue comments still gets no cluster access.
  That grant is bounded by namespace rather than by object name, because the
  names are content-derived and cannot be enumerated in advance; the field
  encryption is what keeps read access from being credential access.
- Every credential in the cluster at the time of the incident is unrecoverable.
  One re-link per user was required regardless of this change.
- **Adding `@kubernetes/client-node` to the gateway pushed a container that was
  already under-provisioned over the edge.** This ADR treated the dependency as
  free because it was already in the monorepo, and did not look at the limit of
  the container newly loading it (256 MiB).

  A user was then asked to authorize twice. Measured afterwards, in this image:
  one `claude` CLI process is ~152 MiB RSS, the gateway's own process ~112 MiB,
  and two `claude` processes plus the gateway ~411 MiB anon / ~590 MiB with page
  cache. An Agent declaring both `claude` and `claude-remote` starts both link
  flows on one turn (ADR 0030 §4) and the first flow's PTY stays alive for ten
  minutes awaiting the user's code — so two of those coexist by design. **256 MiB
  never fit that, and did not fit even one subprocess**; `claude auth login`
  alone drove a fresh container to 280 MiB. What this change did was consume the
  slack that had been letting a single flow squeak through.

  It presented as neither a crash nor a log line: `oom_kill 0`, no restart. The
  second PTY spawned into a cgroup with no cache headroom, printed nothing inside
  its 30s authorize-URL timeout (a large Node CLI's startup is mostly reading its
  own JS), and its flow was reported as failed-to-start — so the user authorized
  the one link offered and the next turn offered the other.

  Fixed by sizing the gateway for what it actually runs (1Gi/1, matching
  agent-orchestrator) plus an in-turn retry so a transient start failure cannot
  cost a second authorization round. Two lessons, and the second is the one that
  actually cost the incident: "the dependency is already used elsewhere in the
  repo" says nothing about whether the container adding it has room; and a
  service that spawns subprocesses must be sized for the subprocesses, which this
  one never was.

  Worth revisiting: this store needs five REST verbs and one watch on a single
  resource type. Implemented against `fetch` with the ServiceAccount token it
  would cost approximately nothing, and the 88 MiB buys very little here.
- **Session pages have the same defect and are not fixed here.** Their store's
  own comment claims it "survives a gateway pod restart", and it does — but not
  the Redis pod's. Those links are posted into GitHub comments and may be opened
  days later. Left as follow-up: the failure is a dead link, not a re-auth
  prompt.
