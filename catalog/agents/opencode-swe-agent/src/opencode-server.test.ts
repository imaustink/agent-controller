import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, forwardRequest, narrateOpencodeEvent, sendMessage, subscribeEvents } from "./opencode-server.js";

/**
 * Stands in for a real `opencode serve` process (ADR 0026) -- these tests
 * exercise the HTTP/SSE client logic in `opencode-server.ts` against a fake
 * server shaped like opencode's own confirmed `/doc` OpenAPI responses,
 * without needing the real `opencode` CLI installed in CI.
 */
const auth = { username: "opencode-swe-agent", password: "test-password" };

describe("opencode-server HTTP client", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { method: string; url: string; body: unknown; authorization?: string } | undefined;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        lastRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          body: raw ? JSON.parse(raw) : undefined,
          authorization: req.headers.authorization,
        };

        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_abc123" }));
          return;
        }
        if (req.url === "/session/ses_abc123/message" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              info: {},
              parts: [{ type: "text", text: "Opened PR #7" }],
            }),
          );
          return;
        }
        if (req.url === "/session/ses_fail/message" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              info: { error: { message: "provider auth failed" } },
              parts: [],
            }),
          );
          return;
        }
        if (req.url === "/session/ses_abc123/permission/req-1/reply" && req.method === "POST") {
          res.writeHead(204).end();
          return;
        }
        if (req.url === "/event" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ type: "message.part.updated", part: { text: "hi" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "session.idle" })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("creates a session, authenticated with Basic auth", async () => {
    await expect(createSession(baseUrl, auth)).resolves.toEqual({ id: "ses_abc123" });
    expect(lastRequest?.authorization).toBe(`Basic ${Buffer.from("opencode-swe-agent:test-password").toString("base64")}`);
  });

  it("sends a message and extracts the final text on success", async () => {
    const result = await sendMessage(baseUrl, "ses_abc123", "add a health check", auth);
    expect(result).toEqual({ finalMessage: "Opened PR #7", failed: false, failureDetail: null });
    expect(lastRequest).toMatchObject({
      method: "POST",
      url: "/session/ses_abc123/message",
      body: { parts: [{ type: "text", text: "add a health check" }] },
    });
  });

  it("reports a failed turn via info.error", async () => {
    const result = await sendMessage(baseUrl, "ses_fail", "do the thing", auth);
    expect(result).toEqual({ finalMessage: null, failed: true, failureDetail: "provider auth failed" });
  });

  it("forwards an arbitrary proxied request and returns its status/body", async () => {
    const result = await forwardRequest(
      baseUrl,
      { method: "POST", path: "/session/ses_abc123/permission/req-1/reply", body: { approved: true } },
      auth,
    );
    expect(result.status).toBe(204);
    expect(lastRequest).toMatchObject({
      method: "POST",
      url: "/session/ses_abc123/permission/req-1/reply",
      body: { approved: true },
    });
  });

  it("streams and parses SSE events until the response ends", async () => {
    const events: unknown[] = [];
    const abort = new AbortController();
    await subscribeEvents(baseUrl, auth, (event) => events.push(event), abort.signal);
    expect(events).toEqual([{ type: "message.part.updated", part: { text: "hi" } }, { type: "session.idle" }]);
  });
});

describe("narrateOpencodeEvent", () => {
  it("narrates a real per-token text delta as agent-text", () => {
    expect(
      narrateOpencodeEvent({
        type: "session.next.text.delta",
        properties: { sessionID: "ses_1", assistantMessageID: "msg_1", textID: "txt_1", delta: "Let's look at " },
      }),
    ).toEqual({ message: "Let's look at ", stage: "agent-text" });
  });

  it("narrates a tool call as a terse agent status line", () => {
    expect(
      narrateOpencodeEvent({
        type: "session.next.tool.called",
        properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "call_1", tool: "bash", input: {} },
      }),
    ).toEqual({ message: "running bash", stage: "agent" });
  });

  it("ignores event types with no chat-worthy narration", () => {
    expect(narrateOpencodeEvent({ type: "session.next.step.started", properties: {} })).toBeUndefined();
    expect(narrateOpencodeEvent({ type: "session.next.text.delta", properties: { delta: "" } })).toBeUndefined();
    expect(narrateOpencodeEvent(null)).toBeUndefined();
    expect(narrateOpencodeEvent("not an object")).toBeUndefined();
  });
});
