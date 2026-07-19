# web-fetch

> One tool container in the [controller-agent](../../README.md) collection. Shared
> conventions (the event protocol and security model every tool follows) live at
> the repo root: [docs/messaging.md](../../docs/messaging.md) and
> [docs/security.md](../../docs/security.md).

A self-contained, security-hardened **subagent container** that fetches a
page and returns its main readable content. A URL goes in; the page's title
and extracted text (as Markdown) comes out.

It exists to pair with [`web-search`](../web-search/README.md): that tool
returns only short snippets from SearXNG, so once the agent has picked a
promising result it calls this tool on that result's URL to actually read the
page.

## What it does

Given a URL (as a single CLI argument), the container:

1. **Validates** the input is non-empty and under a length cap, then runs it
   through the SSRF guard (`src/security/url-guard.ts`): scheme allowlist
   (`http:`/`https:` only) and a resolved-IP block-list covering loopback,
   private, link-local (including the cloud metadata IP), CGNAT, and other
   non-public ranges. The guard re-validates on every redirect hop.
2. **Fetches** the page's HTML with a capped, timed-out GET
   (`WEB_FETCH_MAX_BYTES`, `WEB_FETCH_TIMEOUT_MS`).
3. **Extracts** the main article text via
   [Readability](https://github.com/mozilla/readability) (the same library
   `recipe-scraper` uses), falling back to the raw page text if Readability
   finds no distinct article content.
4. **Renders** the title and extracted text as Markdown, truncated to
   `WEB_FETCH_MAX_CHARS`.

## Known limitations

Unlike `recipe-scraper`'s web extractor, this tool does **not** run a
headless browser -- it only sees whatever HTML the server returns for a plain
GET. Pages whose content is rendered client-side by JavaScript after load may
come back thin or empty. That trade-off keeps the image small and fast (no
Chromium); if a specific site needs JS rendering, `recipe-scraper`'s
extractor is the pattern to reach for instead.

## Configuration

See `.env.example`. Nothing is required; the rest are the standard
messaging-transport env vars shared by every tool (see `docs/messaging.md`).

## Running locally

```sh
docker build -f tools/web-fetch/Dockerfile -t web-fetch:latest ../..
./run.sh 'https://example.com/some-article'
```

## Development

```sh
npm install
npm run typecheck
npm test
```
