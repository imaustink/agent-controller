import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentState } from "./agent/graph.js";
import type { SessionStore } from "./session/types.js";
import {
  buildAgentRequest,
  chatCompletionChunk,
  chatCompletionId,
  chatCompletionResponse,
  errorStatusAndCode,
  listModelsResponse,
  MODEL_ID,
  nodeStatusText,
  openAiError,
  renderResult,
  writeSseChunk,
  writeSseComment,
  writeSseDone,
  writeSseStatus,
} from "./openai/chat-completions.js";
import { withHeartbeat } from "./openai/with-heartbeat.js";

export type InvocationStatus = "pending" | "succeeded" | "failed";

export interface InvocationRecord {
  id: string;
  status: InvocationStatus;
  result?: unknown;
  error?: string;
}

/** How often to emit an SSE keep-alive comment while waiting on a slow graph step (e.g. a tool Job). */
const HEARTBEAT_MS = 15_000;

/**
 * Conversation-id header forwarded by Open WebUI on every upstream request
 * when its deployment sets `ENABLE_FORWARD_USER_INFO_HEADERS=true`
 * (docs/adr/0012). Absent header -> stateless per-turn skill selection,
 * exactly the pre-0012 behavior.
 */
const CHAT_ID_HEADER = "x-openwebui-chat-id";

/** Input passed to the agent graph for one turn (see AgentStateAnnotation in agent/graph.ts). */
export interface AgentGraphInput {
  request: string;
  authToken: string;
  /** Active skill id from the caller's session, if any (docs/adr/0012). */
  activeSkillId?: string;
  /** Identity subject the session record was created under (docs/adr/0012). */
  sessionSubject?: string;
}

/** The slice of the compiled LangGraph agent this server needs — kept small and mockable for tests. */
export interface AgentGraphLike {
  invoke(input: AgentGraphInput): Promise<AgentState>;
  /** `updates` mode: each yielded item is `{ [nodeName]: <that node's partial state update> }`. */
  stream(
    input: AgentGraphInput,
    options: { streamMode: "updates" },
  ): Promise<AsyncIterable<Record<string, Partial<AgentState>>>>;
}

/**
 * Consumer-facing HTTP interface (ADR 0006). Deliberately asynchronous:
 * `POST /invoke` returns immediately with an id; the caller polls
 * `GET /invoke/:id` for the result. A synchronous request/response would
 * hold the HTTP connection open for as long as the launched tool Job takes
 * (e.g. video transcription can take minutes), risking proxy/client
 * timeouts — see ADR 0006 for the alternatives considered.
 *
 * Runs on its own port (`AGENT_HTTP_PORT`), separate from the
 * Job-callback port (`CallbackReceiver`, `AGENT_CALLBACK_PORT`) so the two
 * can be exposed differently at the network level: this one to whoever is
 * allowed to call the agent, the callback port only to Job pods in-cluster.
 *
 * Authorization is intentionally NOT re-implemented here: the caller's
 * bearer token is passed straight through to the agent graph, which already
 * resolves identity and fails closed (docs/orchestrator.md#security-considerations).
 * Keeping auth in one place avoids two divergent implementations drifting
 * apart.
 *
 * Also serves an OpenAI Chat Completions-compatible facade on the same port
 * (`GET /v1/models`, `POST /v1/chat/completions`) so chat UIs that speak the
 * OpenAI API (e.g. Open WebUI) can call the agent directly (ADR 0007). This
 * is a thin translation layer over the same graph — it doesn't change how
 * `/invoke` behaves.
 */
export class InvokeServer {
  private server: Server | undefined;
  private readonly invocations = new Map<string, InvocationRecord>();

  constructor(
    private readonly graph: AgentGraphLike,
    /**
     * Optional conversation-session store (docs/adr/0012). When present and
     * the caller supplies a conversation id (the Open WebUI chat-id header,
     * or `session_id` on /invoke), the turn's selected skill is remembered
     * and offered to the graph on the next turn. Absent -> fully stateless.
     */
    private readonly sessionStore?: SessionStore,
  ) {}

  /** Builds the graph input for one turn, folding in any session-scoped active skill (docs/adr/0012). */
  private buildGraphInput(request: string, authToken: string, sessionId: string | undefined): AgentGraphInput {
    const input: AgentGraphInput = { request, authToken };
    if (!sessionId || !this.sessionStore) return input;
    const record = this.sessionStore.get(sessionId);
    if (!record) return input;
    input.activeSkillId = record.activeSkillId;
    input.sessionSubject = record.subject;
    return input;
  }

  /**
   * Remembers the turn's selected skill for the conversation. The record is
   * bound to the resolved identity subject so a guessed conversation id
   * can't pull another caller's skill context (docs/adr/0012).
   */
  private persistSession(
    sessionId: string | undefined,
    identity: { subject: string } | undefined,
    selectedSkill: { id: string } | undefined,
  ): void {
    if (!sessionId || !this.sessionStore || !identity || !selectedSkill) return;
    this.sessionStore.set(sessionId, { subject: identity.subject, activeSkillId: selectedSkill.id });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
          if (!res.writableEnded) res.writeHead(500).end();
        });
      });
      this.server.listen(port, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/invoke") {
      await this.handleInvoke(req, res);
      return;
    }

    const match = /^\/invoke\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      this.handleGetInvocation(res, match[1] as string);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(listModelsResponse()));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await this.handleChatCompletions(req, res);
      return;
    }

    res.writeHead(404).end();
  }

  private async handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);

    let request: string;
    let sessionId: string | undefined;
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { request?: unknown }).request !== "string" ||
        (parsed as { request: string }).request.trim() === ""
      ) {
        throw new Error("invalid body");
      }
      request = (parsed as { request: string }).request;
      const rawSessionId = (parsed as { session_id?: unknown }).session_id;
      sessionId = typeof rawSessionId === "string" && rawSessionId.trim() !== "" ? rawSessionId : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "body must be JSON: { \"request\": \"<non-empty string>\" }" }),
      );
      return;
    }

    const authToken = bearerToken(req.headers.authorization);
    const id = randomUUID();
    this.invocations.set(id, { id, status: "pending" });

    // Fire-and-forget: the HTTP response returns immediately; the graph run
    // (which blocks on the launched tool Job's callback) updates the record
    // when it eventually settles.
    this.graph
      .invoke(this.buildGraphInput(request, authToken, sessionId))
      .then((state) => {
        this.persistSession(sessionId, state.identity, state.selectedSkill);
        this.invocations.set(id, {
          id,
          status: state.error ? "failed" : "succeeded",
          result: state.result,
          error: state.error,
        });
      })
      .catch((err: unknown) => {
        this.invocations.set(id, {
          id,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    res.writeHead(202, { "content-type": "application/json", location: `/invoke/${id}` }).end(
      JSON.stringify({ id, status: "pending" }),
    );
  }

  private handleGetInvocation(res: ServerResponse, id: string): void {
    const record = this.invocations.get(id);
    if (!record) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(record));
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    let parsed: { messages?: unknown; model?: unknown; stream?: unknown };
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as typeof parsed) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify(openAiError("body must be valid JSON", "invalid_request")),
      );
      return;
    }

    const request = buildAgentRequest(parsed.messages);
    if (!request) {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify(openAiError('messages must include a non-empty "user" message', "invalid_request")),
      );
      return;
    }

    const model = typeof parsed.model === "string" && parsed.model ? parsed.model : MODEL_ID;
    const authToken = bearerToken(req.headers.authorization);
    const sessionId = headerValue(req.headers[CHAT_ID_HEADER]);
    const stream = parsed.stream === true;

    if (!stream) {
      await this.handleChatCompletionsBlocking(res, request, model, authToken, sessionId);
      return;
    }
    await this.handleChatCompletionsStreaming(res, request, model, authToken, sessionId);
  }

  private async handleChatCompletionsBlocking(
    res: ServerResponse,
    request: string,
    model: string,
    authToken: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const state = await this.graph.invoke(this.buildGraphInput(request, authToken, sessionId));
    if (state.error) {
      const { status, code } = errorStatusAndCode(state.error);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(openAiError(state.error, code)));
      return;
    }
    this.persistSession(sessionId, state.identity, state.selectedSkill);
    const id = chatCompletionId();
    const content = renderResult(state.result);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify(chatCompletionResponse(id, model, content, "stop")),
    );
  }

  private async handleChatCompletionsStreaming(
    res: ServerResponse,
    request: string,
    model: string,
    authToken: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const id = chatCompletionId();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    const finish = (content: string): void => {
      writeSseChunk(res, chatCompletionChunk(id, model, { content }, null));
      writeSseChunk(res, chatCompletionChunk(id, model, {}, "stop"));
      writeSseDone(res);
      res.end();
    };

    try {
      const source = await this.graph.stream(this.buildGraphInput(request, authToken, sessionId), {
        streamMode: "updates",
      });
      // Accumulated across updates so the session can be persisted once the
      // turn reaches a successful terminal node (docs/adr/0012).
      let identity: { subject: string } | undefined;
      let selectedSkill: { id: string } | undefined;
      let skillContinuation = false; // true when checkActiveSkill confirmed an existing session skill
      for await (const item of withHeartbeat(source, HEARTBEAT_MS)) {
        if (item.type === "heartbeat") {
          writeSseComment(res, "keep-alive");
          continue;
        }
        const [nodeName, update] = Object.entries(item.value)[0] as [string, Record<string, unknown>];
        if (update.identity) identity = update.identity as { subject: string };
        if (update.selectedSkill) selectedSkill = update.selectedSkill as { id: string };
        if (nodeName === "checkActiveSkill" && update.selectedSkill) skillContinuation = true;

        if (typeof update.error === "string") {
          finish(`❌ ${update.error}`);
          return;
        }
        if (nodeName === "launchJob") {
          this.persistSession(sessionId, identity, selectedSkill);
          finish(renderResult(update.result));
          return;
        }
        // planAction is also terminal when the planner chose "respond"
        // (no tool call, e.g. asking the user to paste the recipe back) —
        // `result` is set and the graph routes straight to END without ever
        // reaching launchJob, so this must be treated as terminal here too.
        if (nodeName === "planAction" && update.result !== undefined) {
          this.persistSession(sessionId, identity, selectedSkill);
          finish(renderResult(update.result));
          return;
        }
        const text = nodeStatusText(nodeName, update, { skillContinuation });
        if (text) writeSseStatus(res, text);
      }
      // Stream ended without a terminal node update — shouldn't normally
      // happen, but close the SSE stream gracefully rather than hanging.
      finish("❌ agent stream ended unexpectedly");
    } catch (err) {
      finish(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : "";
}

/** Normalizes a possibly-repeated header to its first non-empty value. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() !== "" ? value : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
