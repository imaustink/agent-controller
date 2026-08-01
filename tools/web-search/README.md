# web-search

> One tool container in the [controller-agent](../../README.md) collection. Shared
> conventions (the event protocol and security model every tool follows) live at
> the repo root: [docs/messaging.md](../../docs/messaging.md) and
> [docs/security.md](../../docs/security.md).

A self-contained, security-hardened **subagent container** that searches the
web via an in-cluster [SearXNG](https://docs.searxng.org/) instance. A search
query goes in; a Markdown list of results comes out.

## What it does

Given a search query (as a single CLI argument), the container:

1. **Validates** the input is non-empty text and under a length cap (defense
   in depth even though the query comes from the parent agent).
2. **Queries** the fixed, trusted SearXNG target (`SEARXNG_BASE_URL`, never
   derived from tool input) via its JSON API: `GET /search?q=<query>&format=json`.
3. **Renders** the top results (title, URL, snippet) as a flat Markdown list,
   capped at `WEB_SEARCH_MAX_RESULTS` (default 10).

## Why SearXNG

SearXNG is a self-hostable, privacy-respecting metasearch engine with a JSON
API -- see `charts/agent-controller/templates/searxng.yaml` for how the
in-cluster instance this tool talks to is deployed (optional, off by default,
`searxng.enabled` in `charts/agent-controller/values.yaml`). SearXNG disables
JSON output by default; the bundled `settings.yml` turns it on specifically
for this tool's use, and the Service is ClusterIP-only so it's never reachable
from outside the cluster.

## Configuration

See `.env.example`. `SEARXNG_BASE_URL` is the only required setting; the rest
are the standard messaging-transport env vars shared by every tool (see
`docs/messaging.md`).

## Running locally

```sh
docker build -f tools/web-search/Dockerfile -t web-search:latest ../..
SEARXNG_BASE_URL=http://localhost:8888 ./run.sh 'best pizza dough recipe'
```

## Development

```sh
npm install
npm run typecheck
npm test
```
