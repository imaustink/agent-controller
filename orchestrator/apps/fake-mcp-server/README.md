# fake-mcp-server

E2E-only fixture (ADR 0045): a minimal, deterministic MCP server over
streamable-http that stands in for a third-party MCP server so cluster e2e tests
can exercise the real [`mcp-broker`](../mcp-broker) and real engines end to end
without a real external server. It speaks the streamable-http protocol
statelessly (a fresh `McpServer` + `StreamableHTTPServerTransport` per request,
`sessionIdGenerator: undefined`) on `POST ${MCP_PATH}` (default `/mcp`), with
`GET /healthz` for k8s probes. It exposes a fixed, hard-coded tool set:
`echo` (`{ text }` → that text back, proving argument passing and result
flattening), `whoami` (no args → the inbound `Authorization: Bearer <token>`, or
`anonymous`), and `boom` (no args → an `isError` result with
`"intentional tool error"`, proving the broker's error path). It enforces **no**
auth — it ACCEPTS any or no token and only REFLECTS it; the broker is what
enforces auth. `whoami` reflecting the bearer is the key fixture: it lets a test
prove the broker forwarded the caller's per-user delegated token upstream rather
than a shared credential.
