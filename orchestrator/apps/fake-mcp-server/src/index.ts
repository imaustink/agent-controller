/**
 * The fake-mcp-server process (docs/adr/0045).
 *
 * E2E ONLY. A minimal, deterministic MCP server over streamable-http that
 * stands in for a third-party MCP server, so cluster e2e tests can exercise the
 * real mcp-broker and real engines end to end without a real external server.
 *
 * It speaks the streamable-http protocol STATELESSLY (sessionIdGenerator:
 * undefined): each POST gets a fresh McpServer + StreamableHTTPServerTransport,
 * which are closed when the response finishes. It exposes a FIXED tool set
 * (echo, whoami, boom; see server.ts) and enforces NO auth — it only REFLECTS
 * the inbound Bearer token via whoami, which is how a test proves the broker
 * forwarded the caller's per-user delegated token upstream.
 *
 * HTTP surface:
 *   - POST  {MCP_PATH, default /mcp}  -> the MCP streamable-http endpoint.
 *   - GET   /healthz                  -> 200 {"ok":true} for k8s probes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./server.js";
import { requestContext } from "./request-context.js";

const PORT = Number(process.env.PORT ?? 8080);
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Reads and JSON-parses the request body; returns undefined for an empty body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // MCP frames are small; anything larger is not a request this fixture serves.
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Parse the body ourselves and hand it to the transport (there is no
  // body-parser middleware in this bare node:http server).
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null });
    return;
  }

  // Stateless pattern (SDK docs): a FRESH server + transport per request, with
  // no session id, closed when the response finishes.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);

  // Capture the inbound Authorization header into the per-request async context
  // BEFORE dispatching, so the whoami tool callback can recover the Bearer token
  // (the transport does not pass the HTTP request to tool callbacks).
  await requestContext.run({ authorization: header(req, "authorization") }, () =>
    transport.handleRequest(req, res, body),
  );
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake-mcp-server.invalid");

  if (url.pathname === "/healthz") {
    send(res, 200, { ok: true });
    return;
  }

  if (url.pathname === MCP_PATH && req.method === "POST") {
    void handleMcp(req, res).catch((err: unknown) => {
      console.error("fake-mcp-server request failed:", err);
      if (!res.headersSent) {
        send(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    });
    return;
  }

  send(res, 404, { message: "not found" });
});

httpServer.listen(PORT, () => {
  console.log(`fake-mcp-server listening on :${PORT} (MCP at POST ${MCP_PATH})`);
});
