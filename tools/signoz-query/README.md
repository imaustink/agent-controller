# signoz-query

A self-contained subagent container: a single bounded SigNoz logs/traces/
metrics query in, results out. Part of the `cluster-debug-skill` (see
`charts/community-components/templates/skill-cluster-debug.yaml`), paired
with `kubectl-readonly` to correlate cluster state with observability data.

The `signoz-query` Tool CR, its ServiceAccount, and this skill are defined
solely as Helm templates in `charts/community-components` (there is no
standalone `tool.yaml` — see main's "Remove duplicate plain-CR copies"
cleanup); toggle them with the `signozQuery` / `skills.clusterDebug` keys in
that chart's `values.yaml`.

## Contract

- **Input** (`argv[2]`): a single JSON object, e.g.
  `{"signal":"logs","start":"-1h","end":"now","serviceName":"checkout","filters":[{"key":"severity_text","op":"=","value":"ERROR"}],"limit":50}`.
  A filter's `value` shape is tied to its `op`: `in` takes an array
  (`{"op":"in","value":["a","b"]}`), while `=`/`!=`/`contains` take a single
  string. A mismatch is rejected up front as an `invalid_query` rather than
  forwarded to SigNoz as an opaque error.
- **Output**: the SigNoz `query_range` JSON response, wrapped in a fenced
  code block, delivered via the event contract in `docs/messaging.md`. If the
  response exceeds `SIGNOZ_MAX_RESULT_CHARS` it is truncated and an explicit
  `_Result truncated …_` note follows the fence so the incomplete JSON isn't
  mistaken for a malformed response. A fetch that exceeds
  `SIGNOZ_FETCH_TIMEOUT_MS` fails with a dedicated "request timed out" message.

## Safety model

- **No SSRF surface** — `SIGNOZ_BASE_URL` is a fixed, operator-configured
  env value (the Tool template's `env`, from `signozQuery.baseUrl`), never
  derived from caller input. The caller can only shape the query body, never
  the target host.
- **Read-only** — only `POST /api/v3/query_range` is ever called; no other
  SigNoz endpoint (dashboards, alerts, users, ...) is reachable from this
  code.
- **Bounded lookback** — `SIGNOZ_MAX_LOOKBACK_MS` (default 24h) rejects any
  query whose `end - start` exceeds it, regardless of what the caller asks
  for, to bound both cost and blast radius of a single call.
- **Bounded, redacted result** — the success payload is run through `redact()`
  and clipped to `SIGNOZ_MAX_RESULT_CHARS` (default 100000) before it leaves
  the process, so a misbehaving proxy can't echo the API key back in a 200
  body or emit an unbounded response. The registered API-key value is also
  scrubbed from any surfaced message even without a header prefix.
- **No k8s access** — this tool never touches the Kubernetes API; its
  ServiceAccount (`serviceaccount-signoz-query.yaml`) has zero RBAC bindings.

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
request. Note that for `signal: "metrics"` the payload always uses a fixed
`aggregateOperator: "avg"` over a 60s `step`, so each returned series value
is a 60-second average rather than a raw sample (surfaced in the Tool's
`output` description and the skill markdown so a caller doesn't misread it).

`SIGNOZ_BASE_URL` may include a path prefix for a reverse-proxied SigNoz
(e.g. `https://host/signoz`); `queryRangeUrl` joins the endpoint relative to
it so the prefix is preserved.
