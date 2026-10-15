# Event triggers (`EventSource` + `EventTrigger`)

The implementation contract for [ADR 0048](adr/0048-generic-event-triggers.md).
Every component that produces, matches or acts on an event follows this
document; where code and this document disagree, one of them is a bug.

```
                ┌──────────────────────── integration-gateway ────────────────────────┐
 HTTP webhook ─►│ POST /webhooks/:source  verify ─► parse ─► sender ─► envelope ──┐    │
 CronJob tick ─►│ POST /events/:source/tick  bearer ─► envelope (body = payload) ─┤    │
                │                                                                  ▼    │
                │                       POST /invoke { event: <envelope> } ──► orchestrator
                │                                                                  │    │
                │  ◄── 200 ignored | 202 { id, trigger: { sessionId, reply } } ◄───┘    │
                │  reply adapters: ack ─► poll ─► result ─► onComplete                 │
                └──────────────────────────────────────────────────────────────────────┘
 orchestrator (LangGraph or Temporal): match EventTriggers (CEL) ─► params ─► target
```

## 1. CRDs (`core.controller-agent.dev/v1alpha1`, namespaced)

Both kinds live in the release namespace (the one agent-orchestrator,
integration-gateway and the Temporal gateway watch).

### `EventSource`

How events arrive and how far they are trusted. Exactly one of `webhook` / `cron`.

```yaml
apiVersion: core.controller-agent.dev/v1alpha1
kind: EventSource
metadata: { name: github }          # the name IS the route: POST /webhooks/github
spec:
  webhook:
    verify:
      scheme: hmacSha256            # hmacSha256 | slackV0 | bearer   (no "none": fail closed)
      header: x-hub-signature-256   # hmacSha256: signature header (required); bearer: default "authorization"
      prefix: "sha256="             # hmacSha256 only; stripped before hex compare
      secretRef: { name: github-webhook, key: secret }
    deliveryIdHeader: x-github-delivery   # optional; else a random uuid
  sender:                           # optional — who caused the event
    provider: github                # only "github" today: verified against GitHub team/collaborator roles
    loginFrom: body.sender.login    # CEL -> string
    isBotFrom: body.sender.type == "Bot"   # CEL -> bool (optional; default false)
    repositoryFrom: body.repository.full_name  # CEL -> "owner/name" (optional)
    dropBots: true                  # default true: bot-authored events are dropped (self-trigger guard)
---
kind: EventSource
metadata: { name: nightly-sweep }
spec:
  cron:
    schedule: "0 7 * * *"           # standard 5-field cron
    timeZone: America/Chicago       # optional
    suspend: false                  # optional
    payload: { repo: imaustink/agent-controller }   # optional, any JSON; becomes envelope.body
```

Rules:

- `sender` is only valid with `webhook`. A sender whose provider cannot verify the
  login (resolver returns nothing) drops the event. **An unverified login is never
  forwarded** — a source without `sender` runs with no per-user principal, as the
  gateway's own service identity.
- `slackV0` verifies `x-slack-signature` = `v0=hex(hmac(secret, "v0:" + ts + ":" + rawBody))`
  with `x-slack-request-timestamp` within 300s, and answers Slack's
  `{"type":"url_verification"}` handshake with its `challenge` synchronously
  (nothing is relayed).
- `bearer` compares `header` (default `authorization`, value `Bearer <secret>`;
  a non-`authorization` header carries the raw secret) in constant time.
- Verification happens on the raw bytes **before** parsing; failure is `401`.
- Status: `conditions[type=Ready]`; cron sources also `status.cronJobName`.

### `EventTrigger`

What a matching event dispatches.

```yaml
apiVersion: core.controller-agent.dev/v1alpha1
kind: EventTrigger
metadata: { name: github-pr-review }
spec:
  sourceRef: github                 # optional; restricts to one EventSource
  priority: 0                       # optional; higher wins when several match
  match:
    cel: >-                         # optional; omitted = every event from sourceRef
      headers["x-github-event"] == "pull_request" &&
      body.action == "labeled" && body.label.name == "ai-review"
  params:                           # name -> CEL, evaluated against the envelope
    repo: body.repository.full_name
    number: body.pull_request.number
    label: body.label.name
  sessionKey: "github:{{repo}}#{{number}}"   # optional template (see §4)
  target:                           # exactly one of orchestrator/skillRef/agentRef/toolRef
    agentRef: claude-code-swe-agent
    readOnly: true                  # deterministic write-gate for every run in the turn
    promptTemplate: |               # required unless toolRef; {{param}} substitution
      Review pull request {{repo}}#{{number}} ...
  reply:                            # optional, executed by integration-gateway
    github:
      repository: "{{repo}}"
      issueNumber: "{{number}}"     # issue or PR number
      ack: "Starting a review of this pull request…"   # template; posted before the run
      sessionPage: true             # append a session-page link to ack (needs GATEWAY_PUBLIC_URL)
      result: true                  # post the turn's result as a comment
      removeLabel: "{{label}}"      # removed when the run ends, success or failure
    http:
      url: http://ci-bridge.tools.svc/results   # LITERAL only — never templated (SSRF)
      secretRef: { name: ci-bridge, key: secret }  # optional: x-event-signature: sha256=<hmac(body)>
```

Rules:

- Target `orchestrator: {}` runs an ordinary conversational turn (RAG/skill
  selection) on the rendered prompt. `skillRef` / `agentRef` force that Skill /
  Agent (still re-resolved under the caller's roles; a miss is a turn failure, not
  a fallback). `toolRef` runs that Tool once with `params` as its input, skipping the
  planner; `promptTemplate` is optional for it. Tools take one string input in
  both engines, so the **tool input** is: the string form of `params.input` when
  `params` has exactly one key named `input`; otherwise the params object as
  compact JSON with sorted keys (`{}` when there are no params).
- `readOnly: true` sets `readOnly` on every `AgentRun` and `ToolRun` the turn
  launches (including ones a forced skill delegates to) and suppresses write
  credentials. It is a turn property, not a prompt — it can only restrict.
- Read-only is also the **session's mode**. A trigger turn sets the mode to its
  trigger's `readOnly`, `false` included. A turn no trigger produced (a
  session-page follow-up, a chat prompt on the same session id) inherits it
  and can only restrict it further. So a follow-up in a review's session stays
  read-only, and a writable trigger sharing that session key (triage on the
  same issue) makes it writable again. A read-only turn is never forwarded
  into an agent run that was launched writable; the turn fails instead.
- A trigger whose CEL fails to compile is `Ready=False` and never matches.

## 2. The envelope

Every source produces exactly this JSON object. It is both the `event` field of
`/invoke` and the CEL activation.

| Field | Type | Webhook | Cron |
| --- | --- | --- | --- |
| `source` | string | EventSource name | EventSource name |
| `kind` | string | `"webhook"` | `"cron"` |
| `id` | string | `deliveryIdHeader` value, else uuid | `<source>-<unix seconds>-<8 random hex>` |
| `time` | string | RFC 3339 receipt time (UTC) | RFC 3339 tick time (UTC) |
| `headers` | map<string,string> | request headers, **lower-cased**, with the verify header, `authorization` and `cookie` removed; repeated headers joined with `", "` | `{}` |
| `body` | any JSON | `application/json` → parsed; `application/x-www-form-urlencoded` → object of string fields; anything else → `{"text": "<raw>"}` | `spec.cron.payload`, else `{}` |
| `sender` | map | `{login, isBot}` when `spec.sender` resolved, else `{}` | `{}` |
| `repository` | string | `repositoryFrom` result, else `""` | `""` |

## 3. CEL

One environment, used identically by core-controller (compile-only), the TS
orchestrator + gateway (`@controller-agent/event-triggers`, `@marcbachmann/cel-js`)
and the Temporal gateway (`cel-go`):

- Variables: `source`, `kind`, `id`, `time`, `repository` (string), `headers`
  (map<string,string>), `body` (dyn), `sender` (map<string,dyn>).
- JSON numbers are normalized before evaluation: integral → `int`, otherwise
  `double`, in both runtimes. Integrality is decided on the value (JSON `1.0`
  and `1e3` are ints; integral values outside int64 stay `double`).
- Heterogeneous list/map literals (`[1, "a"]`) are allowed, as in cel-go.
- `matches` patterns must mean the same in RE2 and ECMAScript regex (no inline
  flags like `(?i)`, no lookaround/backreferences).
- Supported, parity-tested subset: literals; `== != < <= > >=`; `&& || !`;
  `?:`; field and index access; `has()`; `in` (list/map); `size()`; string
  `startsWith` / `endsWith` / `contains` / `matches`; `int()` / `string()`;
  macros `exists` / `all` / `map` / `filter`. Anything else is unsupported even if
  one runtime happens to accept it.
- `match.cel` must yield `bool` (a statically non-bool match is a compile error
  → `Ready=False`; a runtime non-bool is a non-match); an evaluation error (e.g.
  missing field) is a **non-match**, logged with the trigger name. A `params`
  expression that fails to compile also makes the trigger `Ready=False`. A param
  value must be JSON-representable (null/bool/int/double/string/list/map, finite
  doubles) — anything else is a `params` error. A `params` evaluation error after a
  match fails the event (`422`, §5) — never a silent empty value.
- The shared fixture file `packages/event-triggers/fixtures/cel-parity.json` is the
  executable definition of this section: every case runs in the TS package's
  tests and in the Temporal engine's Go tests, and both must produce the listed
  verdict / value.

## 4. Matching, params, templates

1. Candidates: `Ready` triggers whose `sourceRef` is empty or equals
   `envelope.source`, and whose `match.cel` is absent or evaluates to `true`.
   `Ready` means `Ready=True` with `observedGeneration` equal to the trigger's
   current `metadata.generation`: after an edit, the previous spec's status
   does not count, and the trigger does not match until core-controller has
   checked the new spec.
2. Winner: highest `priority`, then lexicographically smallest name. (Single
   winner; one event is one turn.)
3. `params` are evaluated to typed values.
4. Templates (`promptTemplate`, `sessionKey`, every `reply.github` string) are
   rendered with `{{ name }}` → the param's string form: string as-is, int in
   decimal, double in shortest round-trip form exactly as ECMAScript
   `Number#toString` (`5`, `0.1`, `1e+21`, `1e-7`), bool `true`/`false`, null `""`,
   list/map as compact JSON with map keys sorted at every level and no HTML
   escaping. A placeholder is `\{\{[ \t\n\f\r]*([^{} \t\n\f\r]+)[ \t\n\f\r]*\}\}`;
   rendering is a single pass (substituted text is never re-expanded) and an
   unknown placeholder is left verbatim. `reply.github.issueNumber` must render
   to a positive integer, else the event fails (`422`).
5. Session id: rendered `sessionKey` (when non-empty), else the caller's
   `session_id`, else `event:<source>:<id>`.

## 5. `/invoke` with an event

Same endpoint and accept/poll contract as ADR 0006, on agent-orchestrator (both
engine modes) and on the Temporal gateway (for direct callers). Request:
`{ "event": <envelope>, "session_id"?: string, "identity_link_flow"?: ... }` —
`request` is optional when `event` is present.

| Outcome | Response |
| --- | --- |
| No trigger matched (including no EventTriggers at all) | `200 {"status":"ignored"}` — no turn, no RAG fallback |
| Matched, params/template error | `422 {"status":"failed","error":"..."}` |
| Matched | `202 {"id","status":"pending","trigger":{"name","sessionId","reply"}}` |

`trigger.reply` is the trigger's `reply` with every template already rendered
(`issueNumber` as a number) or `null`. Polling `GET /invoke/:id` is unchanged.

An event is always matched against the registry. Dispatch is never taken from
the body: `forcedSkillId`, `forcedAgentId`, `forcedToolId`, `toolInput`,
`params` and `triggerName` in an `/invoke` body are ignored by
agent-orchestrator and refused with `400` by the Temporal gateway. The Temporal
gateway honours a body `readOnly: true`, which can only restrict.

agent-orchestrator → Temporal gateway carries the resolved turn, never the
envelope. Body: `request` (rendered prompt), `sessionId`, `readOnly` (only
`true`), `targetRepository` (`envelope.repository`). The dispatch itself
travels in the signed `x-orchestrator-dispatch-assertion` header, an
HMAC-SHA256 `<payload>.<signature>` under the sender-assertion secret with
payload `{typ:"dispatch", triggerName, forcedSkillId | forcedAgentId |
forcedToolId, toolInput, readOnly, params, sessionId, requestSha256, exp}`.
It is bound to the turn's session and prompt and expires after 300 s. The
gateway refuses (`400`) an invalid, expired or mis-bound assertion and one sent
with an `event`. Without the secret, agent-orchestrator fails a Temporal-mode
trigger turn instead of sending it unsigned.

## 6. Runs

| CR field | Container env |
| --- | --- |
| `AgentRun.spec.readOnly` | `AGENT_READ_ONLY=true` |
| `AgentRun.spec.params` (map<string,string>) | `AGENT_PARAMS=<json object>` |
| `ToolRun.spec.readOnly` | `TOOL_READ_ONLY=true` |

`@controller-agent/agent-runtime` exposes them as `session.readOnly` /
`session.params`. The SWE agents enforce read-only (deny `git push`, `gh pr
create|merge|close|reopen|ready|edit`, mint a `contents:read` token) from
`session.readOnly` alone.

## 7. Gateway endpoints

- `POST /webhooks/:source` — `404` unknown or non-webhook source; `401` failed
  verification; `202` otherwise (relay continues in the background). Dropped
  events (bot, unresolved sender) are `202` + a log line, so senders don't retry.
  Before resolving a source's `sender` (live GitHub API calls), the gateway
  checks its read-only view of the EventTriggers: a delivery no trigger for this
  source could match is dropped there (`202` + log line), so pushes, check runs
  and other unwatched events cost no API calls. A trigger whose `match.cel` reads
  `sender` or `repository` can't be decided before resolution and counts as a
  possible match. This view only ever drops early; matching stays the
  orchestrator's, and an event that survives is still sender-verified.
- `POST /events/:source/tick` — `Authorization: Bearer <projected SA token>`.
  The gateway verifies it against the cluster's ServiceAccount issuer keys
  (`/.well-known/openid-configuration`, `/openid/v1/jwks`) for audience
  `integration-gateway.events`, a lifetime of at most an hour, and
  requires the username `system:serviceaccount:<CRD_NAMESPACE>:eventsource-<source>`
  — anything else (including another source's tick) is `401`, before the source
  is looked up; then `404` unless the source is `cron`; `202`.
- Reply adapters run only for the `reply` the orchestrator returned: `github.ack`
  (+ session page link) before polling; `github.result` / `http` after;
  `github.removeLabel` after, on every outcome, through the durable pending-action
  store so a crash mid-run still clears it.

## 8. Cron

core-controller turns each `cron` EventSource into an owned `ServiceAccount`
and `CronJob`, both `eventsource-<name>`. The ServiceAccount is the tick's
identity: `automountServiceAccountToken: false`, bound to no Role (it
authenticates; it is authorized for nothing). The CronJob
(`concurrencyPolicy: Forbid`, hardened pod) runs as it, mounting only a
projected token for audience `integration-gateway.events` (600s, pod-bound), and
runs `curl -fsS -X POST --variable token@<file> --expand-header "Authorization:
Bearer {{token:trim}}" $EVENT_TICK_URL/events/<name>/tick` — no shell, no
token on a command line. There is no shared secret: nothing to generate, store
or rotate, and it renders identically under Helm and Argo CD.

The controller never adopts a same-named ServiceAccount it does not own (that
would let someone else's pods tick the source) and deletes both objects when the
source stops being cron. Controller env: `EVENT_TICK_URL` (gateway base URL),
`EVENT_TICK_IMAGE` (curl ≥ 8.3; default `curlimages/curl:8.11.1`). Without
`EVENT_TICK_URL` a cron source is `Ready=False` (`TickNotConfigured`). The
gateway needs no extra RBAC for this (every ServiceAccount may read the
issuer keys, via `system:service-account-issuer-discovery`) and reads the
payload from the CR, not from the tick. Verifying locally, unlike
TokenReview, does not notice a ServiceAccount deleted after the token was
minted; the tick token's 10-minute life bounds that.
