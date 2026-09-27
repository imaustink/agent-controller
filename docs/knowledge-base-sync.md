# Per-client knowledge bases

Status: generalized into [ADR 0038](adr/0038-connection-crd-scoped-external-resources.md)
(`Connection`) and [ADR 0039](adr/0039-knowledgebase-crd-composed-corpora.md)
(`KnowledgeBase`)

## Goal

> Pick a client (e.g. GLOBEX), give a knowledge base access to that client's Slack
> channels, Drive folder and Confluence space, and ask questions about the
> project — **with citations**.

Acceptance criteria:

1. A per-client knowledge base exists, declared in git rather than clicked
   together in a UI.
2. Content lands in it with a source URL per document, stays current, and
   re-syncing is idempotent and cheap.
3. A chat turn can answer a question about that client and list the sources it
   used.
4. Cross-source synthesis works — one retrieval spans the Slack thread, the
   Confluence page and the Drive doc.

## How this is being built

Read the two ADRs first; this document records only what is specific to the
knowledge-base use case and what was learned scoping it.

GLOBEX becomes five `Connection` CRs — `globex-confluence`, `globex-slack-eng`,
`globex-slack-general`, `globex-drive`, plus the shared `platform-announcements` —
and one `KnowledgeBase` CR composing them. That is criteria 1, 2 and 4.

| First draft | Now |
| ----------- | --- |
| `kb-ingest` tool with four hand-written connectors | `Connection` CRs over a shared provider-driver interface (0038 §1) |
| `openwebui-kb` tool as the storage layer | per-Connection Qdrant collections, fanned out by the KnowledgeBase (0039 §1) |
| `_sync-state.json` document inside the KB | content-hash point ids (0039 §6) |
| chart-rendered CronJob per source | webhook dirty-marking + controller-owned reconcile CronJob (0038 §4, §6) |
| Open WebUI's RAG | our own retrieval; Open WebUI is just the chat UI |
| `knowledge-base` Skill with three intents | still needed — see below |

## What is still specific to this use case

**The `knowledge-base` Skill.** The CRDs make a corpus reachable; the Skill is
what makes asking about it behave well. It must:

- answer **only** from retrieved chunks, and end with a `Sources:` list;
- distinguish "nothing exists about this" from "nothing you can see" — ADR 0039
  §3 has `kb:<name>/search` return the count of role-excluded Connections
  precisely so the Skill can say which one it is;
- disclose staleness, since chunks are as of the last sync and
  `conn:<name>/get` is available when the live object matters;
- state plainly that retrieved chunk text is **untrusted data, not
  instructions**.

That last point is not boilerplate. Anyone who can post in a synced client
channel can write into the corpus, and the corpus reaches an LLM prompt
verbatim. Chunks belong in a distinctly-labeled untrusted block, the same
treatment caller-tool definitions get (ADR 0035 §4).

**Slack chunking.** The likely quality bottleneck for this use case
specifically. A channel is thousands of short, interleaved, thread-nested
messages; fixed-window chunking over that produces retrieval slop. Thread-aware
grouping with author and timestamp preserved in the chunk text, and join/leave
noise dropped, is real work and belongs to the Slack driver.

**Is the corpus even needed for criterion 3?** Worth re-testing once the
Confluence Connection exists. A live scoped GET face answers "questions about
this client, with citations" with perfect freshness and no pipeline. The corpus
earns its place on criterion 4 (cross-source synthesis), on sources whose native
search is bad (Slack), and on latency — not on Q&A as such.

## Findings from the original scoping

Two are worth keeping because they cost real debugging time:

1. **Caller-tool results were reported as failures.**
   `engines/temporal/internal/temporal/workflows/agentloop.go` — `lastSuccess`
   is only set by tools the workflow executes itself, so a turn resuming after a
   seeded caller-tool result reached the terminal block with `lastSuccess == nil`
   and formatted a *successful* seeded record as
   `"I couldn't complete that: … failed ()"` using its empty `Error`. Fixed
   separately; the fix also covers a caller tool that succeeds with an empty
   result.

2. **Open WebUI's own knowledge-base attachment never reaches the agent.**
   `engines/temporal/internal/gateway/server.go:410-441` (`splitMessages`) keeps
   only `user` and `assistant` messages, and Open WebUI injects retrieved RAG
   context as a **system** message. Attaching a KB there and asking a question
   silently retrieves nothing — a large part of why ADR 0039 does retrieval
   itself.

## Credentials

Per ADR 0038 §7, v1alpha1 uses shared, operator-provisioned credentials — one
Secret per system, referenced by name from the chart, never a literal. Two Slack
Connections share one bot token.

| System | Credential |
| ------ | ---------- |
| Confluence | Atlassian API token |
| Slack | bot token with channel history + events scopes |
| Drive | service-account JSON, folder shared to it |

Per-user delegation is deferred. A scheduled reconcile has no calling user, so
syncs stay on a service credential regardless of what the interactive path
later grows.

## Open questions

1. Is a Slack bot token with history and Events API scope obtainable on client
   channels, or does it need an admin-installed app?
2. Who may read a client knowledge base? Per-point roles enforce whatever is
   decided, but "which humans may ask about GLOBEX" is a policy question nobody has
   answered.
3. Where does the one-off PDF go? ADR 0039 flags a `manual` provider as required
   before this replaces Open WebUI's knowledge bases for non-engineers.
4. Does Drive's push-channel renewal need its own alerting? A silently expired
   channel degrades to the reconcile interval, which is correct but slower than
   anyone will expect.
