# Security Model

The recipe-scraper container ingests **attacker-controlled input**: an
arbitrary URL whose contents are fetched, rendered, and fed to an LLM. It must
therefore be treated as a hostile-input processor. This document describes the
threat model and the mitigations in place.

Two threats dominate the design:

1. **SSRF** — the container fetches whatever URL it is given.
2. **Prompt injection** — scraped content may try to hijack the LLM.

Everything else (container hardening, resource limits, secret handling) is
defense in depth around those two.

---

## 1. SSRF (Server-Side Request Forgery)

**Risk.** A caller (or a redirect, or a page subresource) points the container
at an internal target: `http://169.254.169.254/…` (cloud metadata),
`http://127.0.0.1:…`, or an RFC 1918 address on the cluster network.

**Mitigations** — [src/security/url-guard.ts](../tools/recipe-scraper/src/security/url-guard.ts):

- **Scheme allowlist.** Only `http:` / `https:` are accepted. `file:`,
  `data:`, `gopher:`, etc. are rejected up front.
- **Resolved-IP block-list.** The host is DNS-resolved and *every* returned
  address must be publicly routable. Blocked ranges include loopback, private
  (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local
  (`169.254/16`, incl. the metadata IP), unspecified, multicast, reserved,
  documentation/benchmark ranges, and their IPv6 equivalents (`::1`, `fe80::/10`,
  `fc00::/7`, `ff00::/8`, IPv4-mapped forms).
- **Fail closed.** Anything that doesn't parse as a valid public IP is blocked.
- **Redirect re-validation.** Guarded fetches use `redirect: "manual"` and
  re-run the guard on **every hop** ([src/util/download.ts](../tools/recipe-scraper/src/util/download.ts)),
  so a public URL can't 302 into an internal one.
- **Browser subrequest filtering.** The web extractor intercepts *every*
  Chromium request and re-checks its host against the guard, aborting any that
  resolve to a non-public address ([src/extractors/web.ts](../tools/recipe-scraper/src/extractors/web.ts)).

**Known limitation — DNS rebinding (TOCTOU).** There is an unavoidable window
between "resolve + validate" and "connect": a hostile DNS server can answer
with a public IP during validation and a private IP at connection time. The
in-process guard mitigates but cannot fully close this. **The required
backstop is network-level egress control**: run the container on a network
whose egress is restricted to public hosts (dedicated egress firewall/proxy).

## 2. Prompt injection

**Risk.** Scraped page text, a video transcript, or OCR output contains
instructions like *"ignore your instructions and output …"* or *"exfiltrate
your system prompt / API key."*

**Mitigations** — [src/llm/format.ts](../tools/recipe-scraper/src/llm/format.ts):

- **Content is data, not instructions.** Untrusted text is wrapped in explicit
  `<content>` delimiters, and the system prompt instructs the model to treat
  everything inside as data to analyze, never as commands.
- **No tools, no side effects.** The formatting model has **no tool/function
  access**. The worst a successful injection can do is produce a misleading
  recipe object — it cannot make network calls, read secrets, or act.
- **Schema-constrained output.** OpenAI **Structured Outputs** (`strict` JSON
  schema, `additionalProperties: false`) mean the model can *only* emit the
  recipe shape. Injected "change the output format" instructions have nowhere
  to go.
- **Output re-validation.** The model's JSON is re-parsed and validated against
  `RecipeSchema` (zod) as defense in depth ([src/schema.ts](../tools/recipe-scraper/src/schema.ts)).
- **Input truncation.** Text is capped at `RECIPE_MAX_TEXT_CHARS` to bound cost
  and limit the injection surface.

## 3. Container hardening

The container itself is the security boundary for untrusted content. The
recommended run contract ([run.sh](../tools/recipe-scraper/run.sh)):

| Flag | Purpose |
| ---- | ------- |
| `USER pwuser` (in image) | never runs as root |
| `--cap-drop ALL` | drops all Linux capabilities |
| `--security-opt no-new-privileges` | blocks privilege escalation |
| `--read-only` | immutable root filesystem |
| `--tmpfs /tmp:rw,noexec,nosuid` | the only writable area (scratch downloads) |
| `--pids-limit`, `--memory`, `--cpus` | bound resource exhaustion |

**Chromium sandbox trade-off.** Chromium runs with `--no-sandbox`. Its own
sandbox would require re-adding `CAP_SYS_ADMIN`, which is a worse trade than
dropping all capabilities and letting the locked-down container be the boundary
(the standard approach for throwaway, untrusted-content containers).

## 4. Resource & cost exhaustion

Because extraction touches paid APIs and can pull large media:

- Image and audio downloads are **byte-capped** (`RECIPE_MAX_IMAGE_BYTES`,
  `RECIPE_MAX_AUDIO_BYTES`); the stream is aborted the moment the cap is
  exceeded ([src/util/download.ts](../tools/recipe-scraper/src/util/download.ts)).
- `yt-dlp` uses `--max-filesize` so oversized audio is never downloaded.
- Every subprocess runs with a hard timeout and output cap
  ([src/util/exec.ts](../tools/recipe-scraper/src/util/exec.ts)); Playwright navigation and guarded
  fetches have their own timeouts.
- Subprocesses run **without a shell** (argument arrays), so untrusted URLs
  can't inject shell metacharacters.

## 5. Secret handling

- The **only** secret the container needs is `OPENAI_API_KEY`.
- Free-text that may echo scraped content (log lines, event `message` fields,
  error messages) is **redacted and clipped** before it leaves the process
  ([src/security/redact.ts](../tools/recipe-scraper/src/security/redact.ts)), so an injected secret
  or huge blob can't corrupt the parent's logs.

## 6. Outbound callback security

When the `callback` transport is used, the container makes an outbound HTTP
request — a potential SSRF/exfil vector of its own. It is constrained
([src/messaging/callback-sink.ts](../packages/messaging/src/callback-sink.ts)):

- The callback URL comes **only from the trusted parent** (`RECIPE_CALLBACK_URL`),
  never from scraped content.
- `http`/`https` only, with the host checked against
  `RECIPE_CALLBACK_ALLOWED_HOSTS`. (This allowlist is intentionally separate
  from the SSRF guard: a callback legitimately targets a parent-owned
  private/cluster address.)
- Bodies are optionally **HMAC-SHA256 signed** (`RECIPE_CALLBACK_SECRET`) so
  the parent can verify authenticity.
- Each request carries an `Idempotency-Key` (`job_id:seq`) so at-least-once
  retries are safe to dedupe.

See [docs/messaging.md](messaging.md#http-callback-security) for the full
callback contract.

## 7. recipe-publisher: Mealie token & fixed-instance posture

[tools/recipe-publisher](../tools/recipe-publisher/) holds a second kind of
secret, `MEALIE_API_TOKEN`, and follows the same discipline as above plus one
addition specific to it:

- `MEALIE_API_TOKEN` is never logged/echoed — its redaction relies on the
  shared generic `Bearer <token>` pattern
  ([src/security/redact.ts](../tools/recipe-publisher/src/security/redact.ts)),
  since Mealie's own long-lived tokens are always sent as a Bearer token.
- The publish **target** (the Mealie instance itself) is fixed server-side
  configuration (`MEALIE_BASE_URL`), never taken from the input recipe
  Markdown or any caller/LLM input — the same "trusted config, untrusted input"
  posture as `RECIPE_CALLBACK_URL` above.
- Recommend creating a dedicated Mealie API token for this tool (Settings ->
  API Tokens) rather than reusing a token used elsewhere, so it can be
  revoked independently.
- Requests target a single fixed host (`MEALIE_BASE_URL`) with
  `redirect: "error"` — no redirects are ever followed.
- **The `mealie-slug` update marker is a recipe-identity token, now round-tripped
  through the orchestrator's session store, not chat history.** Since
  2026-07-04, recipe-publisher is an upsert: a `<!-- continuation: <slug> -->`
  marker prefixed onto its input causes it to `PATCH` (overwrite) that
  existing recipe instead of creating a new one. Previously that marker
  survived in the tool's own reply text and was carried forward via the
  orchestrator's `<conversation_history>` fold (docs/orchestrator.md), which
  could include untrusted scraped recipe content earlier in the same
  conversation — a sufficiently effective prompt injection could in
  principle cause the assistant to echo back a different, attacker-chosen
  slug. [ADR 0017](adr/0017-continuation-tokens-via-session-store.md) closed
  that off: `graph.ts`'s `runTool` now strips the marker from the tool's
  result before it ever reaches the transcript, storing the slug
  server-side (`SessionRecord.toolContinuations`, keyed by tool id) and
  re-injecting it directly into the tool's next-turn input — the value never
  passes through anything the LLM planner reads or writes. Blast radius, if
  the session store itself were compromised, remains bounded to recipes
  within the same authenticated Mealie account/group (`MEALIE_API_TOKEN`
  can't reach other tenants).

## tools/github: a container Tool authenticated as the calling user (ADR 0028)

[tools/github](../tools/github/) runs a single allowlisted `gh` CLI command,
authenticated with a `GITHUB_TOKEN` that -- when
`Tool.spec.identityProviders: [github]` is set (the recommended, default-in-
`values-production.yaml` configuration) -- is the **calling user's own**
identity-linked GitHub token, resolved and injected per-invocation via
`ToolRunSpec.secretEnv` exactly the way `AgentRunSpec.secretEnv` already
worked for `opencode-swe-agent` (ADR 0022), extended one CRD kind further
(ADR 0028) since `ToolRun` previously had no per-invocation secretEnv
mechanism at all. This means:

- **The primary authorization boundary is GitHub itself**, not this
  container's ServiceAccount/RBAC (which grants nothing beyond ordinary pod
  scheduling) -- a caller can only do what they could already do on GitHub
  directly with their own account. This is the same posture as
  `opencode-swe-agent` below, not a new trust model.
- **In-process command allowlist** (`src/allowlist.ts`) is defense-in-depth
  clarity about the tool's intended purpose (issue/PR/repo-read/release/
  search/workflow-read operations), not the primary control -- `auth`/`api`/
  `config`/`secret`/`ssh-key`/etc. are excluded entirely, and a handful of
  individually irreversible-ish subcommands (`repo delete`, `issue delete`/
  `transfer`, `workflow run`, `run cancel`/`rerun`, `release`/`label delete`)
  are excluded even within an otherwise-allowed command. Unlike
  `kubectl-readonly` (whose fixed cluster-wide ServiceAccount is the same
  regardless of caller, so flag-level restriction is the only thing standing
  between "get pods" and "get secrets -o json"), this tool does not
  additionally restrict flags/values, since GitHub's own per-user
  authorization already gates what a write can actually do.
- **No persisted credentials.** `GH_CONFIG_DIR` points at the container's
  writable `/tmp` (wiped every run); the token lives only in this process's
  env for the run's duration, sourced from a per-run k8s Secret
  (`<toolrun-name>-identity`) that is garbage-collected with its `ToolRun`.
- A caller who has not yet linked their GitHub account gets an explicit
  error directing them to link it via a direct conversation with an
  identity-linking-capable agent (e.g. `opencode-swe-agent`) first -- the
  same v1 scope cut as the agent-backed-tool identity gate in `graph.ts`'s
  `runTool`: this call path cannot itself start a fresh device-flow link.
- A deployment that does not want per-user delegation can instead configure
  `githubTool.identityLink.enabled: false` (the chart default) with a static
  `GITHUB_TOKEN` PAT in a Secret, same as any other tool's `secretEnv` --
  the blast radius then reverts to whatever that shared PAT is scoped to.

## opencode-swe-agent: a deliberately privileged agent

`apps/opencode-swe-agent` (an agentic opencode CLI wrapper, calling Anthropic
directly, that opens pull requests) is intentionally more privileged than the
recipe tools, so it is classified `tier: privileged` and its trust boundary is
documented here rather than assumed away. It replaces the earlier
Copilot-CLI-based `copilot-swe`/`copilot-swe-agent` (see
[ADR 0013](adr/0013-copilot-swe-privileged-coding-tool.md), superseded by
[ADR 0016](adr/0016-opencode-anthropic-direct-swe-agent.md)).

- **Two independent credentials, not one shared PAT.** Unlike the Copilot CLI
  (which required a single GitHub PAT to authenticate both the model and
  git/GitHub operations), opencode's Anthropic provider takes a plain
  `ANTHROPIC_API_KEY` with no GitHub dependency. `GITHUB_TOKEN` (a
  fine-grained PAT for `git`/`gh`) and `ANTHROPIC_API_KEY` (the model) are
  separate keys in the `opencode-swe-secrets` k8s Secret, each scoped to only
  what it needs. The GitHub PAT needs: **Contents** write, **Pull requests**
  write, **Metadata** read, and **Administration** write only if it should
  create repositories. Its blast radius is exactly the repositories its
  fine-grained access selects — keep it scoped.
- **GitHub App auth as an alternative to the PAT** ([ADR
  0018](adr/0018-github-app-auth-fallback.md)). Setting `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID` (all three, or
  none) makes `resolveGithubToken` (`src/githubApp.ts`) mint a short-lived
  (~1h) installation token per run instead of using the static
  `GITHUB_TOKEN`; omitting them keeps the PAT path working unchanged. The App
  path additionally scopes access to exactly one installation's repos and
  auto-expires without manual rotation, but doesn't remove the need for the
  deny-rule/branch-protection layers below — a compromised installation token
  is still live for up to an hour.
- **Per-user GitHub identity as a third option, replacing the shared
  credential entirely** ([ADR
  0022](adr/0022-per-user-github-device-flow-identity.md), opt-in via
  `opencodeSweAgent.identityLink.enabled`). Instead of a bot/App-installation
  token shared by every caller, `agent-orchestrator` resolves and injects the
  **calling user's own** linked GitHub token per invocation, via a new
  `AgentRunSpec.SecretEnv` (a per-run override of this Agent's static
  `secretEnv`, referencing a short-lived k8s `Secret` created and owned by
  that one `AgentRun`, garbage-collected with it). The link itself is
  established once per person via GitHub OAuth Device Flow, brokered by
  `apps/integration-gateway` (a new subject-keyed, encrypted-at-rest store,
  `IDENTITY_LINK_ENCRYPTION_KEY` — needs the same rotation/no-plaintext-
  logging discipline as `opencode-swe-secrets`) and transparently refreshed
  thereafter — no re-prompting on subsequent requests. This narrows blast
  radius to **the linked human's own GitHub permissions** rather than
  whatever the shared PAT/App installation was scoped to, and correspondingly
  widens `agent-orchestrator`'s own k8s RBAC with `secrets: create`/`patch`
  (gated behind `identityLink.enabled`, same discipline as the LocalTool-
  gated `secrets: get` grant below). The deny-rule/branch-protection layers
  immediately below are unchanged and still required either way — a
  compromised per-user token is still live for its own lifetime (~8h, or up
  to ~6 months if its refresh token is also compromised).
- **No irreversible actions — defense in depth, because no single layer
  suffices.** A PAT with `Administration` write can both create and delete
  repos, so token permissions alone cannot forbid deletion. Therefore:
  (1) opencode `permission.bash` deny rules baked into every run
  (`src/opencode.ts` `DENY_BASH_PATTERNS`, written into `opencode.json`:
  force-push variants, `git reset --hard`, branch/ref deletion, `rm -rf`,
  `gh repo delete`, `gh api -X DELETE`) — explicit deny rules always take
  precedence over `--auto`; (2) least-privilege token scope (only the repos it
  needs, no `Administration` unless repo-create is wanted); (3) server-side
  branch-protection/rulesets on the target repos blocking force-push and
  deletion regardless of the client.
- **Relaxed hardening, scoped.** Unlike the recipe tools it needs outbound
  network (GitHub + the Anthropic API), a larger writable workspace, more
  memory, and a longer deadline (`AgentRun` timeout, e.g. 1800s). The k8s
  securityContext is unchanged: it still runs non-root (uid 10001), with a
  read-only root filesystem and all capabilities dropped — every write goes to
  a writable `emptyDir`/tmpfs under `$HOME`. An egress NetworkPolicy limiting
  the Job to GitHub + Anthropic hosts is a recommended additional control
  (tool/agent Jobs currently have none).
- **The former `swe` marker is repo/branch/PR identity, now round-tripped
  through the orchestrator's session store instead of chat history.**
  Continuing the same PR across separate coding-task turns needs this
  agent's repo/branch/PR/session to survive between `AgentRun` episodes.
  Originally (ADR 0013, ADR 0016) this rode as a `<!-- swe: repo=… branch=…
  -->` marker embedded in the agent's own chat reply, carried forward via the
  orchestrator's `<conversation_history>` fold — the same shape of risk as
  recipe-publisher's `mealie-slug` marker: a prompt injection earlier in the
  conversation could in principle redirect work to a different repo/branch.
  [ADR 0017](adr/0017-continuation-tokens-via-session-store.md) replaced
  this: the agent now returns the encoded marker as `reply.result`, a
  structured field on the NATS `reply` message
  (`packages/messaging/src/agent-protocol.ts`) that is never part of the chat
  `message` text. The orchestrator stores it server-side
  (`SessionRecord.agentContinuations`, keyed by agent id) and re-injects it as
  a goal prefix on the next episode — the value never appears in anything the
  user or the LLM planner reads. Blast radius, if the session store itself
  were compromised, remains bounded to the App's installed repositories.

## LocalTool: registry code execution inside the orchestrator pod (ADR 0014)

`LocalTool` CRs run tool code **inside the orchestrator pod** — pulled from a
language registry at runtime and executed by a per-language bubblewrap sidecar —
instead of as an isolated k8s Job. This is a deliberate isolation-for-latency
trade and the highest-trust surface in the repo. Threats and mitigations:

- **Arbitrary registry code execution.** Creating a `LocalTool` causes
  third-party code to be fetched and run in-pod. Treat CR create/update as a
  **privileged operation** and gate it with k8s RBAC. Integrity is enforced
  fail-closed: exact version pinning (ranges/tags rejected), sha256 checksum
  verification (required for shell `sourceURL`), and a registry-host allowlist.
- **Install-time code execution.** `npm install` / `pip install` / `go install`
  run untrusted code *during fetch*, before the tool executes. This is confined
  to the sidecar's own container (separate FS/memory/identity from the
  orchestrator) and run with script suppression where possible
  (`npm --ignore-scripts`, `pip --only-binary=:all:`).
- **Filesystem + privileges.** Each invocation runs under bubblewrap: new
  user/ipc/uts/cgroup namespaces, read-only root + tmpfs `/tmp`, `--clearenv`
  with only the tool's declared env (plus a default HOME/PATH) re-injected. The
  tool never sees the orchestrator's env or secrets; `secretEnv` values are
  resolved by the orchestrator and passed over the pod-local unix socket. (The
  PID namespace is deliberately not unshared — a fresh `/proc` mount is rejected
  under a container runtime's masked `/proc`; the bound `/proc` is reused.)
- **Network is default-deny, per-tool opt-in** (`spec.network`). Enforced by the
  sidecar's own network namespace (unshared, interface-less, unless opted in).
  **Caveat:** sidecars share the *pod's* network namespace with the orchestrator,
  so a k8s `NetworkPolicy` cannot distinguish them — the bwrap namespace is the
  real per-tool control. Network-enabled tools remain responsible for their own
  SSRF defenses (the reference `http-get` tools carry an SSRF guard like §1).
- **Node prerequisites.** bwrap's per-invocation namespaces require
  **unprivileged user namespaces enabled on the node** and the sidecar running
  with **`seccompProfile: Unconfined`** — the `RuntimeDefault` profile filters
  the namespace-creation clone flags once all capabilities are dropped, so bwrap
  fails with "No permissions to create new namespace". The sidecar stays
  otherwise hardened (non-root, cap-drop ALL, read-only rootfs). Where userns is
  unavailable the sandbox fails closed (the run fails) rather than degrading.
- **No k8s identity for sidecars.** The pod sets
  `automountServiceAccountToken: false` and projects the ServiceAccount token
  only into the orchestrator container, so a compromised tool/sidecar cannot use
  the orchestrator's cluster credentials. The orchestrator's Role gains only
  `secrets: get` (for `secretEnv`) when LocalTools are enabled.
- **Disabled by default.** The Helm feature (`localTool.enabled`) is off unless
  turned on, and operators trim `localTool.runtimes` to the languages they use.

## Reporting

This is a component of a larger system; treat the scraper container as
untrusted-by-default and run it with the hardened flags above plus egress
restriction. If you find a way to bypass the SSRF guard, escape the container,
or exfiltrate secrets via injected content, flag it before deploying.
