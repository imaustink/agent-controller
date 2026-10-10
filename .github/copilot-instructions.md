# Copilot Instructions — controller-agent

## Architecture

npm workspaces monorepo in three layers (ADR 0047; see [README.md](../README.md)
for the full layout and [docs/orchestrator.md](../docs/orchestrator.md) +
[docs/adr/](../docs/adr/) for the orchestrator's design rationale):

- `framework/*` — what agents and tools are built with: the canonical wire
  contract (`framework/protocol`, `.proto` + generated TS/Go), the tool event
  protocol and sinks (`@controller-agent/messaging`), the agent SDK
  (`@controller-agent/agent-runtime`) and `@controller-agent/github-app-auth`.
  Depends on nothing else in this repo. Depend on these instead of
  copy-pasting logic between tools/agents.
- `catalog/*` — reference implementations built on the framework:
  `catalog/tools/*` (one Docker container per **on-demand, single-shot** tool
  call, e.g. `recipe-scraper`: URL in, recipe JSON out, process exits),
  `catalog/agents/*` (**sub-agent containers** on the agent SDK, e.g.
  `opencode-swe-agent`, an opencode-CLI coding agent that communicates
  bidirectionally with the orchestrator over NATS) and `catalog/tools-local/*`.
- `orchestrator/*` — what runs them at scale: `orchestrator/apps/*`
  (**long-lived services**: `agent-orchestrator`, the parent agent that
  RAG-selects a skill/sub-agent, launches it and awaits its result; the
  gateways and brokers), `orchestrator/engines/temporal`,
  `orchestrator/controllers/core-controller`, `orchestrator/sidecars/*` and
  `orchestrator/charts/*`.

Every tool/agent/app is self-contained (own deps, own image, own hardened run
contract) and never imports from a sibling directly — only from `framework/*`.
`npm run check:boundaries` enforces the layering (`boundaries.json`).

## Build and test (run from repo root)

- `npm install` — always from the **repo root**, never per-package (links
  workspace packages).
- `npm run build` / `npm run typecheck` / `npm test` — run across all
  workspaces. Scope to one with `--workspace=<name>` (e.g.
  `--workspace=agent-orchestrator`).
- Build the shared package before typechecking/testing a dependent workspace
  if you've changed it: `npm run build --workspace=@controller-agent/messaging`.
- Docker builds use the **repo root** as build context (not the tool/app
  dir), because images need to COPY in `framework/messaging`:
  `docker build -f catalog/tools/recipe-scraper/Dockerfile -t recipe-scraper:latest .`
  (same pattern for `orchestrator/apps/agent-orchestrator/Dockerfile`).
- This repo is **not a git repository** — use `mv`/`cp`, not `git mv`, when
  restructuring files. After moving a workspace package, reinstall; if
  `package-lock.json` still references the old path afterward, do a full
  clean reinstall (`rm -rf node_modules package-lock.json */*/node_modules && npm install`).

## Conventions

- TypeScript, Node ESM, `NodeNext` module resolution — relative imports
  **must** use explicit `.js` extensions (even though the source is `.ts`).
- Treat all external input as untrusted (scraped content, request bodies,
  caller-supplied tokens). See [docs/security.md](../docs/security.md) for
  the concrete threat model (SSRF, prompt injection) and mitigations —
  follow the same discipline in new tools/apps rather than re-deriving it.
- Tool/app-to-parent communication uses the shared event protocol
  (`accepted → progress* / warning* → succeeded | failed`) implemented once
  in `@controller-agent/messaging` — see [docs/messaging.md](../docs/messaging.md).
  Depend on the package; don't reimplement the protocol.
- **Make core behavior deterministic, not prompt-dependent.** For anything
  core — auth/account-linking, access disclosure, citations, tool gating — do
  NOT rely on the agent following a system-prompt instruction to produce the
  required behavior; the model may not comply and a core feature must not
  depend on that. When the orchestrator already has the structured signal
  (e.g. a KB search activity returns `needsLink` / `linkProviders`), surface or
  gate on it deterministically in code (append the message, interrupt the turn)
  rather than adding guidance text and hoping the model relays it. Reserve
  prompt instructions for genuinely generative/judgment work.
- Never invent unverified auth/identity shortcuts. `orchestrator/apps/agent-orchestrator/src/rbac/static-identity-resolver.ts`
  is explicitly a DEV/TEST-ONLY stub (no signature verification) — treat it
  as a documented gap, not a pattern to copy for real auth.
- k8s API access goes through `@kubernetes/client-node` in-process (object-param
  APIs, e.g. `api.createNamespacedJob({ namespace, body })`), never by
  shelling out to `kubectl`.
- New tool/app checklist lives in [README.md § Adding a new tool](../README.md#adding-a-new-tool).
