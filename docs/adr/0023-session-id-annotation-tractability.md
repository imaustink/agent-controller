# 0023. Caller's Open WebUI session id is annotated onto every launched ToolRun/AgentRun Job and Pod

Date: 2026-07-21

## Status

Accepted

## Context

A single Open WebUI conversation can fan out into an arbitrary number of
ToolRun/AgentRun Jobs across a turn (a tool call, a skill's agent delegation,
a sub-agent's own tool calls, etc. — ADR 0010/0021). None of those Jobs or
Pods carried any link back to the conversation that spawned them: `kubectl
get pods`/`kubectl describe` showed only the `core.controller-agent.dev/
{toolrun,agentrun,tool,agent}` labels (ADR 0010), which identify *which*
Tool/Agent ran, not *which conversation* asked for it.

This is a debugging gap today (a failing Job can't be traced back to "which
Open WebUI chat caused this" without cross-referencing timestamps), and it
blocks a specific near-term integration: an agent/skill whose job is to
**debug the current session** — e.g. "something in this conversation's tool
calls just failed, go find the Job(s), read their logs/events, and open a PR
fixing whatever's wrong." That agent needs a reliable handle to query the
cluster for exactly this conversation's Jobs; nothing in the system provided
one.

The session id itself already exists — `x-openwebui-chat-id`
(`CHAT_ID_HEADER`, `apps/agent-orchestrator/src/server.ts`) or the `/invoke`
`session_id` body field, the same id ADR 0012's `SessionStore` is keyed by —
it just never propagated past `buildGraphInput`.

## Decision

1. **`AgentGraphInput`/`AgentStateAnnotation` gain a plain `sessionId` field**
   (`apps/agent-orchestrator/src/server.ts`, `src/agent/graph.ts`), set
   whenever the caller supplied one — independent of whether a `SessionStore`
   is configured at all (unlike `sessionSubject`/`activeSkillId`/etc., which
   only exist when session continuity, ADR 0012, is active). This is a
   correlation id for debugging, not a continuity mechanism — no RBAC/subject
   check gates it the way `sessionSubject` gates active-skill resumption.
2. **Every launch call in `graph.ts` forwards `state.sessionId`** as
   `options.sessionId` to `ContainerToolLauncher.launch` and
   `AgentRunLauncherPort.launch` (`src/k8s/{container-tool,agentrun}-
   launcher.ts`).
3. **`ToolRunLauncher`/`AgentRunLauncher` set it as a CR annotation**,
   `controller-agent.dev/session-id`, on the `ToolRun`/`AgentRun` custom
   resource's own `metadata.annotations` — not a new typed CRD spec field, so
   no CRD schema/regeneration was needed for something that carries no
   validated shape and no reconciliation behavior.
4. **The Go core-controller copies just that one annotation onto the Job it
   builds — and its Pod template** (`controllers/core-controller/internal/
   controller/run_job.go`'s `buildRunJob`, via a new `sessionIDAnnotations`
   helper called from both `toolrun_controller.go` and
   `agentrun_controller.go`). Deliberately narrow — it copies only the
   `SessionIDAnnotation` key, not the CR's whole annotation map, so an
   unrelated annotation someone sets on the CR by hand (e.g. `kubectl
   apply`'s `last-applied-configuration`) never leaks onto the Job/Pod.
5. **LocalTools (ADR 0014) get it via env, not an annotation.** A LocalTool
   runs in-pod via the executor sidecar — there is no separate Job/Pod to
   annotate. `LocalToolExecutor.run` accepts an optional `sessionId` and, when
   given, sets `SESSION_ID` in the tool process's own env (alongside its
   declared `env`/`secretEnv`), so a LocalTool that logs can include it.
   Containerized tools/agents get no equivalent env var — the annotation
   alone is the intended debugging surface for those; wiring `SESSION_ID` into
   every tool/agent's structured logs was explicitly out of scope for this
   decision.

## Consequences

- `kubectl get pods -o jsonpath='{.items[?(@.metadata.annotations.controller-agent\.dev/session-id=="<chat-id>")].metadata.name}'`
  (or the equivalent list-CRs-by-annotation query against `ToolRun`/
  `AgentRun`) now finds every Job/Pod one Open WebUI conversation caused,
  across however many tool calls and agent delegations it fanned out into.
  This is the intended building block for a future "debug this session"
  agent/skill: given a session id (from the chat itself, or forwarded by Open
  WebUI), it can enumerate the conversation's Jobs, pull their events/logs,
  and act on what it finds (e.g. open a PR) — no new lookup mechanism needed
  beyond this annotation.
- No CRD schema changed (annotation, not a spec field) — no regeneration,
  no versioning/migration concern if the key or its presence ever changes.
- A caller that never sends a session id (a bare `curl` to `/invoke`, a test)
  gets no annotation at all, identical to today's behavior — this is
  additive-only.
- Container tool/agent Jobs do not get `SESSION_ID` in their own env/logs by
  design (only LocalTools do); correlating a containerized Job's *log lines*
  back to a session still requires going through the Job/Pod annotation
  first, not grepping logs directly. If a future consumer needs that, it is a
  separate decision (e.g. requires each Tool/Agent image's own logging
  convention to adopt a new env var, which this ADR deliberately did not
  mandate).
