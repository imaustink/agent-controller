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
| [0013](0013-copilot-swe-privileged-coding-tool.md) | A privileged `copilot-swe` tool wraps the agentic Copilot CLI to open pull requests; GitHub App token for git, Copilot PAT for the model, deny-rule guardrails |
| [0014](0014-local-tool-sidecar-execution.md) | `LocalTool` CRD + per-language executor sidecar run lightweight tools in-pod (stdio ABI), trading some isolation for lower latency than a k8s Job |
| [0015](0015-post-tool-response-composition.md) | A generic `composeResponse` node lets the active skill's markdown add follow-up narration around a tool's verbatim result, replacing the hard-coded recipe-scraper prompt in the agent graph |

Status values: `proposed` | `accepted` | `superseded by NNNN`.
