# 0013. Privileged `copilot-swe` coding tool

Status: accepted

## Context

The orchestrator's tools so far (recipe-scraper, recipe-publisher) are small,
deterministic, single-shot utilities: one string in, one result out, run under
a strict hardened contract (cap-drop ALL, read-only root fs, ~256Mi, 300s
deadline, no persistent state). We want a tool that performs open-ended
**software-engineering tasks on GitHub** — create/clone a repo, write code and
tests, commit, push, and open a pull request — driven by the agentic **GitHub
Copilot CLI** (`copilot -p`).

This is a different shape of workload:

- It is itself an LLM agent loop (opaque to the orchestrator), not a
  deterministic utility. From the orchestrator's perspective, though, it is
  still a single tool call.
- It needs outbound network to GitHub and the Copilot API, a writable
  workspace, more memory, and a much longer deadline than 300s.
- It needs write credentials to GitHub, which is a large blast radius.
- Copilot's *model* auth and GitHub's *git/API* auth are distinct: the Copilot
  CLI accepts only a fine-grained PAT with the "Copilot Requests" permission
  (or a Copilot/gh OAuth token) for the model — **not** a GitHub App
  installation token — while we want repo access governed by a GitHub App.

The repo already has an `Agent`/`AgentRun` CRD for "a full agent loop as a
Job", but the orchestrator does not wire Agents into its skill→planner→run
path; only `Tool`s are wired.

## Decision

Add `tools/copilot-swe` as a **`Tool`** (using the fully-wired path), classified
`tier: privileged`, wrapping the Copilot CLI.

1. **Model as a Tool, not an Agent.** Copilot is its own agent loop, so to the
   orchestrator it is one tool call — matching how recipe-scraper's internal
   stages are opaque. Reusing the wired `Tool` path avoids building
   orchestrator-side `Agent` retrieval/launch plumbing.
2. **Two credentials, kept separate.** `COPILOT_GITHUB_TOKEN` (Copilot PAT)
   authenticates the model only. A **GitHub App** (`GITHUB_APP_ID` +
   `GITHUB_APP_PRIVATE_KEY`) mints a short-lived installation token at run time
   for all git/`gh` operations. The built-in Copilot GitHub MCP server is
   disabled (`--disable-builtin-mcps`) so the two never mix; the tool drives
   GitHub via `git` + `gh` under the App token.
3. **Guardrails via deny rules + server-side protection.** Since a GitHub App's
   `Administration:write` cannot separate repo create from delete, "no
   irreversible actions" is enforced in depth: baked-in Copilot `--deny-tool`
   rules (force-push, `git reset --hard`, ref/branch deletion, `rm -rf`,
   `gh repo delete`, `gh api -X DELETE` — deny always wins over `--allow-all`),
   least-privilege App permissions, and repo rulesets blocking force-push and
   deletion.
4. **Branch-as-state multi-turn (Phase A).** Each turn re-clones; durable state
   lives on the pushed branch/PR plus an `<!-- swe: repo=… branch=… pr=… -->`
   marker round-tripped through the orchestrator's `<conversation_history>`
   fold (same technique as recipe-publisher's `mealie-slug`). A persistent
   per-session workspace volume (`--resume`) is deferred (Phase B).
5. **Per-tool timeout.** A new optional `Tool.spec.timeoutSeconds` lets a
   long-running tool raise the Job's `activeDeadlineSeconds` default (e.g.
   1800s) without every caller setting it; a `ToolRun`'s own `timeoutSeconds`
   still wins.

The k8s hardening is otherwise unchanged: the Job still runs non-root (uid
10001) with a read-only root filesystem and all capabilities dropped; the tool
writes only to a writable `emptyDir`/tmpfs under `$HOME`.

## Consequences

- A single tool call can now produce real, externally-visible side effects
  (commits, PRs) against any repository the GitHub App is installed on. The
  trust boundary is documented in [../security.md](../security.md).
- The privileged posture (network egress, write credentials, longer runtime)
  diverges from the recipe tools; `tier: privileged` marks it, and an egress
  NetworkPolicy is a recommended follow-up (tool Jobs currently have none).
- Multi-turn refinement works today via branch-as-state; it re-clones each turn
  and does not preserve uncommitted work or Copilot's own session memory. A
  persistent-workspace PVC (extending `Tool`/`ToolRun` with a workspace volume
  keyed by chat id, plus PVC GC) is the deferred Phase B enhancement.
- The Copilot PAT bills its owning account for the agent's model usage.
