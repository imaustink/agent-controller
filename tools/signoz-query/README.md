# signoz-query

A self-contained subagent container: a single bounded SigNoz logs/traces/
metrics query in, results out. Part of the `cluster-debug-skill` (see
`apps/agent-orchestrator/config/samples/cluster-debug-skill.yaml`), paired
with `kubectl-readonly` to correlate cluster state with observability data.

## Contract

- **Input** (`argv[2]`): a single JSON object, e.g.
  `{"signal":"logs","start":"-1h","end":"now","serviceName":"checkout","filters":[{"key":"severity_text","op":"=","value":"ERROR"}],"limit":50}`.
- **Output**: the SigNoz `query_range` JSON response, wrapped in a fenced
  code block, delivered via the event contract in `docs/messaging.md`.

## Safety model

- **No SSRF surface** — `SIGNOZ_BASE_URL` is a fixed, operator-configured
  env value (`tool.yaml`'s `env`), never derived from caller input. The
  caller can only shape the query body, never the target host.
- **Read-only** — only `POST /api/v3/query_range` is ever called; no other
  SigNoz endpoint (dashboards, alerts, users, ...) is reachable from this
  code.
- **Bounded lookback** — `SIGNOZ_MAX_LOOKBACK_MS` (default 24h) rejects any
  query whose `end - start` exceeds it, regardless of what the caller asks
  for, to bound both cost and blast radius of a single call.
- **No k8s access** — this tool never touches the Kubernetes API; its
  ServiceAccount (`tool.yaml`) has zero RBAC bindings.

## Local development

```sh
npm install
npm run typecheck --workspace=signoz-query
npm run test --workspace=signoz-query
npm run build --workspace=signoz-query
docker build -f tools/signoz-query/Dockerfile -t signoz-query:latest .
SIGNOZ_BASE_URL=http://localhost:8080 SIGNOZ_TRANSPORT=stdout \
  node dist/index.js '{"signal":"logs","start":"-15m","end":"now"}'
```

## SigNoz API version note

`src/signoz.ts` builds a v3 `query_range` builder-mode payload targeting the
common "list recent logs/traces" / "read a metric" shape. SigNoz's v3 query
API has evolved across releases — verify the constructed payload against
your SigNoz version and adjust `buildQueryRangePayload` if it rejects the
request.
