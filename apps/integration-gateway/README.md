# integration-gateway

Phase 1 of [docs/integrations-gateway.md](../../docs/integrations-gateway.md): a
small, direct invocation surface that skips RAG/skill retrieval and launches a
catalog entry by id.

## Scope (phase 1 only)

- **Implemented:** FAAS-style direct HTTP invocation.
- **Not implemented:** Slack/email adapters, `IntegrationRoute` CRDs, NATS
  multi-turn agent channels, or other routing/adapter layers.
- **Result path:** HTTP callback only, reusing the shared
  [`@controller-agent/messaging`](../../packages/messaging/) event protocol.

## What it does

- `POST /fn/:id` with `Authorization: ****** and body
  `{ "input": "...", "args"?: ["..."] }`
- resolves the caller identity,
- looks up a `Tool` or `Agent` custom resource by `:id`,
- re-checks `allowedRoles` as defense in depth,
- creates a `ToolRun` or `AgentRun` CR directly,
- returns `202 { id, status: "pending" }` immediately.

Poll with `GET /fn/runs/:id` until the record becomes
`{ status: "succeeded", result }` or `{ status: "failed", error }`.

## Layout

```text
src/
├── index.ts
├── server.ts
├── types.ts
├── config.ts
├── callback/
│   └── receiver.ts
├── k8s/
│   ├── toolrun-launcher.ts
│   └── agentrun-launcher.ts
├── registry/
│   ├── types.ts
│   └── crd-catalog-registry.ts
└── rbac/
    ├── types.ts
    └── static-identity-resolver.ts
```

## Self-contained duplication

This app deliberately duplicates small pieces of the existing
`apps/agent-orchestrator` launcher, callback-receiver, and RBAC-resolver code
instead of importing across apps. That follows the monorepo convention that
apps stay self-contained and only share code through `packages/*`. If a third
consumer appears, these pieces are good candidates for extraction into a shared
workspace package.

## Building

From the repo root:

```bash
npm install
npm run build --workspace=@controller-agent/messaging
npm run build --workspace=integration-gateway
npm test --workspace=integration-gateway
```
