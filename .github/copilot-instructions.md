# Copilot Instructions — recipe-agent

## Architecture

npm workspaces monorepo, three kinds of members (see [README.md](../README.md)
for the full layout and [docs/orchestrator.md](../docs/orchestrator.md) +
[docs/adr/](../docs/adr/) for the orchestrator's design rationale):

- `packages/*` — shared libraries (currently `@controller-agent/messaging`, the
  transport-agnostic tool-call event protocol). Depend on these instead of
  copy-pasting logic between tools/apps.
- `tools/*` — one Docker container per **on-demand, single-shot** tool call
  (e.g. `recipe-scraper`: URL in, recipe JSON out, process exits).
- `apps/*` — **long-lived services**, currently just `agent-orchestrator` (the
  parent agent: RAG-selects a tool, launches it as a k8s Job, awaits its
  result). Don't confuse this with `tools/*` — it's not an on-demand container.

Every tool/app is self-contained (own deps, own image, own hardened run
contract) and never imports from a sibling tool/app directly — only from
`packages/*`.

## Build and test (run from repo root)

- `npm install` — always from the **repo root**, never per-package (links
  workspace packages).
- `npm run build` / `npm run typecheck` / `npm test` — run across all
  workspaces. Scope to one with `--workspace=<name>` (e.g.
  `--workspace=agent-orchestrator`).
- Build the shared package before typechecking/testing a dependent workspace
  if you've changed it: `npm run build --workspace=@controller-agent/messaging`.
- Docker builds use the **repo root** as build context (not the tool/app
  dir), because images need to COPY in `packages/messaging`:
  `docker build -f tools/recipe-scraper/Dockerfile -t recipe-scraper:latest .`
  (same pattern for `apps/agent-orchestrator/Dockerfile`).
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
- Never invent unverified auth/identity shortcuts. `apps/agent-orchestrator/src/rbac/static-identity-resolver.ts`
  is explicitly a DEV/TEST-ONLY stub (no signature verification) — treat it
  as a documented gap, not a pattern to copy for real auth.
- k8s API access goes through `@kubernetes/client-node` in-process (object-param
  APIs, e.g. `api.createNamespacedJob({ namespace, body })`), never by
  shelling out to `kubectl`.
- New tool/app checklist lives in [README.md § Adding a new tool](../README.md#adding-a-new-tool).
