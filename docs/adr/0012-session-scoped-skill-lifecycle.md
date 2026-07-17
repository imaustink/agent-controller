# 0012. Session-scoped active skill with per-turn fit re-evaluation

Date: 2026-07-04

## Status

Accepted

## Context

A chat conversation routinely spans several turns that all belong to the same
skill ("extract this recipe" → "make it vegetarian" → "publish it"), and may
eventually pivot to a different skill entirely. Since ADR 0008 every turn is
fully stateless: the graph re-runs RAG skill retrieval and LLM skill selection
against just the latest user message (plus one folded assistant response, see
the `<previous_assistant_response>` mechanism). That has two problems as the
skill catalog grows past one entry:

1. **Weak mid-conversation signal.** Follow-up turns like "yes, publish it"
   or "make it spicier" carry almost no semantic content for the RAG query;
   with several skills indexed they will misroute or fail to match, even
   though the conversation's skill is obvious from context.
2. **Wasted work.** Re-embedding the request and re-running retrieval +
   selection LLM calls every turn is pure overhead for the common case where
   the conversation stays inside one skill.

The tempting shortcut — load every skill's markdown into the system prompt so
no per-turn selection is needed — is explicitly rejected: the prompt would
grow linearly with the catalog, skills would bleed instructions into each
other, and the RBAC-scoped retrieval boundary (ADR 0011) would be lost.

We also need the opposite check: once a conversation *has* an active skill,
each new turn must be re-evaluated so a pivot ("now help me with something
else") triggers a fresh skill search instead of being force-fitted into the
stale skill.

The primary chat client is Open WebUI, which (with
`ENABLE_FORWARD_USER_INFO_HEADERS=true` on its deployment) forwards a stable
`X-OpenWebUI-Chat-Id` header on every upstream chat-completions request —
verified against the Open WebUI source (`backend/open_webui/env.py`,
`FORWARD_SESSION_INFO_HEADER_CHAT_ID`). That gives us a conversation key
without inventing a custom protocol.

## Decision

- **Server-side session store keyed by the caller's conversation id.** A new
  `SessionStore` port (`src/session/types.ts`) with an in-memory adapter
  (`InMemorySessionStore`: sliding TTL, max-entry cap with oldest-first
  eviction). The session record stores the resolved identity `subject`, the
  active skill **id**, and a timestamp — never the skill content itself.
- **Conversation id sources:** the `x-openwebui-chat-id` header on
  `POST /v1/chat/completions`, or an optional `session_id` field in the
  `POST /invoke` body. No id → fully stateless per-turn behavior, exactly as
  before (zero regression for other clients).
- **Fit-check first, RAG on miss.** A new `checkActiveSkill` graph node runs
  between `resolveIdentity` and `retrieveSkills`. When the turn arrives with
  an active skill id it: (1) re-fetches the skill by id through the
  RBAC-filtered store (`SkillStore.getByIds`, fail-closed — mirrors
  `VectorStore.getByIds` from ADR 0008/0011), and (2) asks a cheap
  Structured-Outputs LLM (`SkillFitChecker`) whether the new turn still falls
  within that skill's described scope. Fits → jump straight to
  `loadSkillTools`, skipping retrieval + selection. Any miss (skill gone,
  roles revoked, subject mismatch, doesn't fit) → fall through to the full
  `retrieveSkills` → `selectSkill` path. A miss is never an error.
- **Session binding to identity.** The conversation id is caller-supplied and
  guessable, so the session record is bound to the identity `subject`
  resolved from the bearer token. `checkActiveSkill` compares the record's
  subject against the freshly resolved identity and treats a mismatch as "no
  session" — a guessed chat id cannot pull another caller's skill context.
- **Skill content is never cached.** Only the id persists; the markdown and
  tool list are re-fetched under the caller's *current* roles each turn, so a
  role revocation takes effect on the very next message.
- **Strictly one active skill per conversation turn.** Multi-skill merging
  remains out of scope (unchanged from ADR 0008); a conversation that pivots
  simply switches which single skill is active.

## Consequences

- Mid-conversation turns stay correctly routed even with a large skill
  catalog, and the common same-skill turn costs one small fit-check LLM call
  instead of an embedding + retrieval + selection round trip.
- The orchestrator is no longer fully stateless — but the state is a
  best-effort routing hint, not correctness-critical data: losing it (restart,
  TTL expiry, eviction) silently degrades to the old per-turn selection.
  Recipe/agent continuation state (the Mealie slug, opencode-swe's
  repo/branch/PR) now also lives in this same store rather than round-tripping
  through chat history — see
  [ADR 0017](0017-continuation-tokens-via-session-store.md), which superseded
  the original `mealie-slug`/`swe` marker design described when this record
  was written.
- The in-memory adapter assumes a single orchestrator replica (the Helm
  chart's default). With multiple replicas sessions would fragment across
  pods — worst case is harmless re-selection, but a shared store (e.g. Redis)
  behind the same `SessionStore` port is the follow-up if the HPA is ever
  enabled. Documented as a known gap.
- The fit checker is a new LLM trust boundary: the user turn is untrusted
  input, the skill name/description are trusted catalog data, and Structured
  Outputs constrain the response to a boolean — same containment discipline
  as the skill selector (ADR 0008).
- Open WebUI deployments must set `ENABLE_FORWARD_USER_INFO_HEADERS=true`
  (done via `openwebui.extraEnvVars` in the chart's demo values) to benefit;
  without it the header is absent and behavior is unchanged.
