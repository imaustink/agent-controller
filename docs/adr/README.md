# Architecture Decision Records

Short records of significant architecture decisions for the agent
orchestrator, using the standard Context / Decision / Consequences format.
See [../orchestrator.md](../orchestrator.md) for how these fit together.

| # | Decision |
| - | -------- |
| [0001](0001-parent-orchestrator-as-container.md) | Parent orchestrator runs as its own container, launches tools/sub-agents as k8s Jobs |
| [0002](0002-langgraph-agent-loop.md) | Agent reasoning loop built on LangGraph.js |
| [0003](0003-pluggable-vector-store-qdrant.md) | RAG tool index backed by Qdrant behind a swappable `VectorStore` port |
| [0004](0004-rbac-scoped-dynamic-tool-discovery.md) | ~~Tool catalog is discovered dynamically~~ and filtered by caller RBAC, not a static manifest (discovery half superseded by 0009) |
| [0005](0005-kubernetes-client-node-job-launcher.md) | Jobs are created via `@kubernetes/client-node`, not by shelling out to `kubectl` |
| [0006](0006-async-http-invoke-interface.md) | Consumer-facing HTTP interface (`POST /invoke` + `GET /invoke/:id`), async accept/poll, on its own port |
| [0007](0007-openai-compatible-chat-facade.md) | OpenAI Chat Completions-compatible facade (`/v1/models`, `/v1/chat/completions`) as a thin adapter over the same agent graph |
| [0008](0008-skill-mediated-tool-retrieval.md) | Skill-mediated dynamic tool retrieval supersedes flat tool RAG (`retrieveTools`/`selectTool` -> skill retrieval/selection/action-planning) |
| [0009](0009-static-build-time-tool-manifests.md) | ~~Tool catalog is a static, build-time manifest per tool~~ (superseded by 0010) |
| [0010](0010-crd-catalog-and-tool-controller.md) | Tool/Skill catalogs and Job launching move to CRDs (`Tool`/`ToolRun`/`Skill`/`Agent`/`AgentRun`) reconciled by a Go controller |
| [0011](0011-skill-access-derived-from-tools.md) | Skills carry no RBAC of their own — a skill's audience is derived as the intersection of its tools' `allowedRoles` |
| [0012](0012-session-scoped-skill-lifecycle.md) | Conversations keep one session-scoped active skill (keyed by the caller's chat id), re-evaluated per turn by a fit-check — full RAG re-selection only on a miss |
| [0013](0013-copilot-swe-privileged-coding-tool.md) | ~~A privileged `copilot-swe` tool wraps the agentic Copilot CLI to open pull requests; GitHub App token for git, Copilot PAT for the model, deny-rule guardrails~~ (model/auth mechanism superseded by 0016) |
| [0014](0014-local-tool-sidecar-execution.md) | `LocalTool` CRD + per-language executor sidecar run lightweight tools in-pod (stdio ABI), trading some isolation for lower latency than a k8s Job |
| [0015](0015-post-tool-response-composition.md) | A generic `composeResponse` node lets the active skill's markdown add follow-up narration around a tool's verbatim result, replacing the hard-coded recipe-scraper prompt in the agent graph |
| [0016](0016-opencode-anthropic-direct-swe-agent.md) | `opencode-swe-agent` replaces the Copilot CLI with the opencode CLI calling Anthropic (Claude Sonnet 5) directly; `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are now independent secrets (its `<!-- swe: ... -->` marker choice superseded by 0017) |
| [0017](0017-continuation-tokens-via-session-store.md) | Per-tool/per-agent continuation tokens (Mealie slug, opencode-swe repo/branch/PR/session) move from an in-transcript HTML-comment marker to the session store, closing the prompt-injection surface that marker was a documented risk for |
| [0018](0018-github-app-auth-fallback.md) | `opencode-swe-agent` supports GitHub App installation tokens as an alternative to the static `GITHUB_TOKEN` PAT, falling back to the PAT when App credentials aren't configured |
| [0019](0019-capability-need-gate.md) | A cheap `CapabilityNeedChecker` gate skips catalog retrieval (and the self-improvement suggestion) for purely conversational turns that were never going to match a skill/tool/agent |
| [0020](0020-crd-catalog-hot-reload-via-k8s-watch.md) | Tool/LocalTool/Skill/Agent registries hot-reload via a live k8s watch instead of only refreshing on orchestrator restart |
| [0021](0021-skill-agent-refs.md) | `Skill.spec.agentRefs` lets a Skill delegate to an Agent directly (dispatched exactly like an agent-backed Tool) — no `Tool` wrapper CR required |
| [0022](0022-per-user-github-device-flow-identity.md) | Identity-requiring Agents (e.g. `opencode-swe-agent`) act as the calling user's own linked GitHub identity (OAuth Device Flow via `integration-gateway`, injected per-run through a new `AgentRunSpec.SecretEnv`), replacing the shared PAT/App-installation token for those deployments |
| [0023](0023-session-id-annotation-tractability.md) | The caller's Open WebUI session id is annotated (`controller-agent.dev/session-id`) onto every ToolRun/AgentRun CR and the Job/Pod it launches, so a conversation's Jobs can be traced/queried by session id — the building block for a future session-debugging agent |
| [0024](0024-integration-route-crd-for-deterministic-event-routing.md) | A new `IntegrationRoute` CRD declaratively maps an inbound integration-gateway event (e.g. a GitHub issue assigned to the bot) to a target Skill/Agent/Tool and prompt template, letting `/invoke` bypass RAG skill retrieval for triggers whose intent is already unambiguous |
| [0025](0025-triage-agent-starting-work-comment-and-session-page.md) | The `issues.labeled` triage trigger posts an upfront "starting work" comment (before the turn runs, not just after) linking to a minimal server-rendered session page for watching turn history and sending follow-up prompts |
| [0026](0026-live-opencode-session-nats-tunnel.md) | `opencode-swe-agent` runs a long-lived `opencode serve` process tunneled over the existing per-run NATS channel, letting the session page show its live event stream and send it prompts directly instead of only queuing conversational turns |
| [0027](0027-tool-level-identity-delegation-and-github-cli-tool.md) | Per-user GitHub identity delegation (0022) extends from `Agent`/`AgentRun` to container `Tool`/`ToolRun` (new `ToolRunSpec.SecretEnv`, `ToolSpec.IdentityProviders`), and a new `github` Tool (gh CLI preinstalled) is added as its reference implementation |

Status values: `proposed` | `accepted` | `superseded by NNNN`.
