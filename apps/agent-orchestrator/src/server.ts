import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentState } from "./agent/graph.js";
import type { AgentOrchestratorChannel } from "./agents/nats-agent-channel.js";
import type { SessionStore } from "./session/types.js";
import { renderPromptTemplate, type CrdIntegrationRouteRegistry } from "./routing/crd-integration-route-registry.js";
import {
  buildAgentRequest,
  chatCompletionChunk,
  chatCompletionId,
  chatCompletionResponse,
  errorStatusAndCode,
  isInternalUiTaskRequest,
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
import type { TaskCompleter } from "./openai/task-completer.js";
import { withHeartbeat } from "./openai/with-heartbeat.js";

export type InvocationStatus = "pending" | "succeeded" | "failed";

export interface InvocationRecord {
  id: string;
  status: InvocationStatus;
  result?: unknown;
  error?: string;
  /**
   * True once this turn has determined the caller must link an identity
   * before any agent can run. Set EARLY (mid-run, before the link URL even
   * exists) via the graph's `reportIdentityLinkPending`, and reaffirmed at
   * terminal from `state.identityLinkPending`. A polling caller
   * (integration-gateway's triage relay) reads this to withhold a premature
   * "starting work" comment and, once terminal, to drive the link-then-resume
   * flow instead of treating the link prompt as a finished result.
   */
  identityLinkPending?: boolean;
  /** Provider + subject the pending link is keyed on, so a caller that owns the token store can wait for completion and auto-resume. Present only alongside `identityLinkPending`. */
  identityLink?: { provider: string; subject: string };
  /**
   * The most recent progress message seen with `stage: "remote-control-url"`
   * (a Remote Control session URL, `https://claude.ai/code/session_...`) --
   * only ever set when the delegated agent actually emits one (today: a
   * later phase of `claude-code-swe-agent`; `opencode-swe-agent` and every
   * other run never sets it). A polling caller (integration-gateway's triage
   * relay) uses this to prefer linking a live Remote Control session over its
   * own session page once available. Omitted/undefined for every run that
   * never emits this progress event -- fully backward compatible.
   */
  remoteControlUrl?: string;
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

/**
 * Per-request signed user JWT forwarded by Open WebUI on every upstream
 * request when its deployment sets `ENABLE_FORWARD_USER_INFO_HEADERS=true`.
 * Unlike the `Authorization` bearer token (a single static value shared by
 * every Open WebUI user), this identifies the specific human sending the
 * request -- see `OpenWebUiForwardedUserResolver`. Absent header -> identity
 * resolution falls back to the shared static/OIDC path, same as before this
 * header was read.
 */
const FORWARDED_USER_JWT_HEADER = "x-openwebui-user-jwt";

/** Input passed to the agent graph for one turn (see AgentStateAnnotation in agent/graph.ts). */
export interface AgentGraphInput {
  request: string;
  authToken: string;
  /**
   * Open WebUI's per-request signed user JWT (`X-OpenWebUI-User-Jwt`), if
   * the caller sent one -- see `FORWARDED_USER_JWT_HEADER` and
   * `OpenWebUiForwardedUserResolver`.
   */
  forwardedUserToken?: string;
  /**
   * Caller's Open WebUI session id (`X-OpenWebUI-Chat-Id` or the `/invoke`
   * `session_id` body field), if any -- forwarded to every launched
   * ToolRun/AgentRun CR as an annotation (docs/adr/0012) so a Job/Pod can be
   * traced back to the conversation that spawned it via `kubectl describe`.
   */
  sessionId?: string;
  /** Active skill id from the caller's session, if any (docs/adr/0012). */
  activeSkillId?: string;
  /** Id of the Agent CR the conversation is continuing, if any. */
  activeAgentId?: string;
  /** Name of the specific AgentRun CR the conversation is continuing, if any. */
  activeAgentRunId?: string;
  /** Identity subject the session record was created under (docs/adr/0012). */
  sessionSubject?: string;
  /** Per-tool continuation tokens from the caller's session, keyed by tool id (docs/adr/0017). */
  toolContinuations?: Record<string, string>;
  /** Per-agent continuation tokens from the caller's session, keyed by agent id (docs/adr/0017). */
  agentContinuations?: Record<string, string>;
  /** A device-flow identity-link attempt this conversation is waiting on, if any (see `SessionRecord.pendingIdentityLink`). */
  pendingIdentityLink?: { agentId: string; provider: string; flow: "device" | "authcode" | "page"; deviceCode?: string; expiresAt: number };
  /**
   * Per-request override of which OAuth flow `delegateToAgent` starts if
   * this caller needs to link an identity (see `AgentState.identityLinkFlow`
   * in agent/graph.ts). Absent -> the graph's own default ("authcode")
   * applies. Only ever set by `handleInvoke`'s `identity_link_flow` body
   * field -- the Open WebUI-facing chat-completions facade never sets this,
   * so it always gets the browser-redirect default.
   */
  identityLinkFlow?: "device" | "authcode";
  /**
   * Per-request progress listener — set by the SSE streaming handler to
   * forward tool Job progress/warning events as Open WebUI status steps.
   * Absent on non-streaming paths (fire-and-forget /invoke, tests) — in
   * which case progress events are silently dropped, same as before.
   * Carried in state rather than graph `deps` so concurrent requests each
   * have their own handler (deps is shared across all requests).
   */
  progressListener?: (stage: string, message: string | undefined) => void;
  /**
   * Separate from `progressListener` above on purpose: `delegateToAgent`
   * treats a set `progressListener` as "this caller has a live channel,
   * synchronously wait for an identity link to land." A fire-and-forget
   * `/invoke` caller that only wants to capture a `remote-control-url`
   * progress event (to post a Remote Control link on a GitHub issue) must
   * NOT be treated as a live channel, or the whole turn silently blocks for
   * minutes with nothing posted anywhere -- exactly the regression this
   * field exists to avoid. See `AgentState.remoteControlUrlListener`'s doc
   * in agent/graph.ts for the full incident writeup.
   */
  remoteControlUrlListener?: (url: string) => void;
  /**
   * Fired the instant this turn decides the caller must link an identity,
   * before the (possibly slow) link `start()`. Set only by `handleInvoke` for
   * the fire-and-forget `/invoke` path, so it can mark the in-flight job
   * identity-link-pending immediately (see `InvocationRecord.identityLinkPending`).
   */
  reportIdentityLinkPending?: (info: { provider: string; subject: string }) => void;
  /**
   * Id of a Skill CR to dispatch to directly, bypassing RAG skill retrieval —
   * set when `/invoke`'s optional `event` field matched an `IntegrationRoute`
   * CR (deterministic event routing, e.g. a GitHub issue being assigned to
   * the bot). Mutually exclusive with `forcedAgentId` in practice (a route
   * has exactly one target), though the graph tolerates either being unset.
   */
  forcedSkillId?: string;
  /** Id of an Agent CR to dispatch to directly — see `forcedSkillId`. */
  forcedAgentId?: string;
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
    /**
     * Answers Open WebUI's internal housekeeping completions (title/tags/
     * query generation, `isInternalUiTaskRequest`) directly, bypassing the
     * agent graph so these can never be misrouted into skill/agent
     * delegation. Absent -> such requests still bypass the graph but get a
     * generic static reply (safety takes priority over title quality).
     */
    private readonly taskCompleter?: TaskCompleter,
    /**
     * Optional declarative event→Skill/Agent/Tool routing table (a new
     * IntegrationRoute CR per docs/integrations-gateway.md's deferred "Open
     * Questions" proposal). Absent -> `/invoke`'s `event` field, if sent, is
     * simply ignored and every request goes through RAG retrieval exactly as
     * before this feature existed.
     */
    private readonly integrationRouteRegistry?: CrdIntegrationRouteRegistry,
    /**
     * Optional live-session tunnel (ADR 0026): lets `GET /sessions/:id/live`,
     * `GET /agent-runs/:id/events`, and `POST /agent-runs/:id/opencode`
     * probe/stream/proxy a still-resident agent Pod. Absent (e.g. no NATS
     * configured) -> those three routes 404, same as if this feature didn't
     * exist; `/invoke` and the chat-completions facade are unaffected either way.
     */
    private readonly agentChannel?: AgentOrchestratorChannel,
  ) {}

  /** Builds the graph input for one turn, folding in any session-scoped active skill or agent run (docs/adr/0012). */
  private async buildGraphInput(
    request: string,
    authToken: string,
    sessionId: string | undefined,
    progressListener?: (stage: string, message: string | undefined) => void,
    identityLinkFlow?: "device" | "authcode",
    forwardedUserToken?: string,
    forcedSkillId?: string,
    forcedAgentId?: string,
    // Deliberately a separate trailing param, not folded into
    // `progressListener` -- see `AgentGraphInput.remoteControlUrlListener`'s
    // doc for why conflating the two caused a real incident (a fire-and-
    // forget triage turn silently blocking for minutes on identity-link's
    // synchronous wait, because setting `progressListener` made
    // delegateToAgent think this caller had a live channel).
    remoteControlUrlListener?: (url: string) => void,
  ): Promise<AgentGraphInput> {
    const input: AgentGraphInput = { request, authToken };
    if (progressListener) input.progressListener = progressListener;
    if (remoteControlUrlListener) input.remoteControlUrlListener = remoteControlUrlListener;
    if (identityLinkFlow) input.identityLinkFlow = identityLinkFlow;
    if (forwardedUserToken) input.forwardedUserToken = forwardedUserToken;
    if (forcedSkillId) input.forcedSkillId = forcedSkillId;
    if (forcedAgentId) input.forcedAgentId = forcedAgentId;
    // Carried through to every launched ToolRun/AgentRun CR as an annotation
    // (docs/adr/0012) purely for kubectl-level debugging -- independent of
    // whether a session store is configured, unlike the fields below.
    if (sessionId) input.sessionId = sessionId;
    if (!sessionId || !this.sessionStore) return input;
    const record = await this.sessionStore.get(sessionId);
    if (!record) return input;
    input.activeSkillId = record.activeSkillId;
    input.activeAgentId = record.activeAgentId;
    input.activeAgentRunId = record.activeAgentRunId;
    input.sessionSubject = record.subject;
    input.toolContinuations = record.toolContinuations;
    input.agentContinuations = record.agentContinuations;
    input.pendingIdentityLink = record.pendingIdentityLink;
    return input;
  }

  /**
   * Remembers the turn's delegation outcome for the conversation, bound to
   * the resolved identity subject so a guessed conversation id can't pull
   * another caller's context (docs/adr/0012). A skill outcome persists
   * `activeSkillId`; an agent outcome persists `activeAgentId`/
   * `activeAgentRunId` ONLY while the agent is still awaiting a further turn
   * (a question) — once it gives its final reply (or fails), the record is
   * cleared to just the subject so the NEXT unrelated turn doesn't try to
   * continue a run that's already exited.
   *
   * Also merges in any tool/agent continuation token extracted THIS turn
   * (docs/adr/0017) on top of whatever was already stored for other tools/
   * agents — re-fetches the current record first since `SessionStore.set`
   * replaces the whole record rather than patching it.
   */
  private async persistSession(
    sessionId: string | undefined,
    identity: { subject: string } | undefined,
    outcome: {
      selectedSkill?: { id: string };
      selectedAgent?: { id: string };
      agentRunId?: string;
      agentAwaitingReply?: boolean;
      extractedContinuation?: { toolId: string; token: string };
      extractedAgentContinuation?: { agentId: string; token: string };
      pendingIdentityLink?: { agentId: string; provider: string; flow: "device" | "authcode" | "page"; deviceCode?: string; expiresAt: number };
      identityLinkPending?: boolean;
    },
  ): Promise<void> {
    if (!sessionId || !this.sessionStore || !identity) return;

    const existing = await this.sessionStore.get(sessionId);
    const toolContinuations = { ...existing?.toolContinuations };
    if (outcome.extractedContinuation) {
      const { toolId, token } = outcome.extractedContinuation;
      if (token) toolContinuations[toolId] = token;
      else delete toolContinuations[toolId];
    }
    const agentContinuations = { ...existing?.agentContinuations };
    if (outcome.extractedAgentContinuation) {
      const { agentId, token } = outcome.extractedAgentContinuation;
      if (token) agentContinuations[agentId] = token;
      else delete agentContinuations[agentId];
    }
    // Omit empty maps rather than persisting `{}` -- keeps a plain session
    // record (no continuations in play) identical to how it looked before
    // this feature existed.
    const base = {
      subject: identity.subject,
      ...(Object.keys(toolContinuations).length > 0 ? { toolContinuations } : {}),
      ...(Object.keys(agentContinuations).length > 0 ? { agentContinuations } : {}),
      // Kept even once activeAgentRunId is cleared below (ADR 0026) -- a
      // live-session viewer's only way to know which run id to probe.
      ...(outcome.agentRunId ? { lastAgentRunId: outcome.agentRunId } : { lastAgentRunId: existing?.lastAgentRunId }),
    };

    if (outcome.identityLinkPending) {
      // A turn paused on a one-time device-flow authorization never also
      // sets selectedSkill/agentRunId (delegateToAgent/checkPendingIdentityLink
      // return early before either), so this is checked first and is always
      // mutually exclusive with the branches below.
      await this.sessionStore.set(sessionId, { ...base, pendingIdentityLink: outcome.pendingIdentityLink });
      return;
    }

    if (outcome.selectedSkill) {
      await this.sessionStore.set(sessionId, { ...base, activeSkillId: outcome.selectedSkill.id });
      return;
    }
    if (outcome.agentRunId) {
      if (outcome.agentAwaitingReply && outcome.selectedAgent) {
        await this.sessionStore.set(sessionId, {
          ...base,
          activeAgentId: outcome.selectedAgent.id,
          activeAgentRunId: outcome.agentRunId,
        });
      } else {
        // Agent finished or failed -- clear active-run state, but keep any
        // continuation tokens just merged in.
        await this.sessionStore.set(sessionId, base);
      }
      return;
    }
    // Neither branch fired (e.g. tool ran under a fresh/unrelated skill
    // that didn't set selectedSkill for some reason) -- still persist any
    // continuation tokens merged in above rather than silently dropping them.
    if (outcome.extractedContinuation || outcome.extractedAgentContinuation) {
      await this.sessionStore.set(sessionId, base);
    }
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

    // Live-session tunnel (ADR 0026) -- `sessionId` travels as a query param
    // rather than a path segment since it commonly contains `#`/`/`
    // (`github:<owner>/<repo>#<issueNumber>`).
    if (req.method === "GET" && url.pathname === "/sessions/live") {
      await this.handleSessionLive(req, res, url);
      return;
    }
    const eventsMatch = /^\/agent-runs\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && eventsMatch) {
      await this.handleAgentRunEvents(req, res, url, eventsMatch[1] as string);
      return;
    }
    const opencodeMatch = /^\/agent-runs\/([^/]+)\/opencode$/.exec(url.pathname);
    if (req.method === "POST" && opencodeMatch) {
      await this.handleAgentRunOpencode(req, res, url, opencodeMatch[1] as string);
      return;
    }

    res.writeHead(404).end();
  }

  /**
   * `GET /sessions/live?sessionId=...` -> `{ live, agentRunId? }` (ADR 0026).
   * Deliberately a real-time NATS round trip against the session's
   * `lastAgentRunId` (a cheap `GET /global/health` proxied through
   * `forwardOpencodeRequest`) rather than trusting any cached liveness flag
   * -- self-corrects if the Pod crashed/was evicted without a clean
   * `session_ended`.
   */
  private async handleSessionLive(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.agentChannel?.forwardOpencodeRequest || !this.sessionStore) {
      res.writeHead(404).end();
      return;
    }
    if (!bearerToken(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "sessionId query param is required" }));
      return;
    }
    const record = await this.sessionStore.get(sessionId);
    const agentRunId = record?.lastAgentRunId;
    if (!agentRunId) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ live: false }));
      return;
    }
    try {
      const probe = await this.agentChannel.forwardOpencodeRequest(agentRunId, { method: "GET", path: "/global/health" }, 2_000);
      const live = probe.status >= 200 && probe.status < 300;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(live ? { live: true, agentRunId } : { live: false }));
    } catch {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ live: false }));
    }
  }

  /**
   * `GET /agent-runs/:runId/events?sessionId=...` -> SSE stream of the run's
   * `opencode_event`s (ADR 0026). `sessionId` is cross-checked against the
   * session store's OWN record of `lastAgentRunId` -- a bare `runId` alone
   * is never trusted, since it's the only thing standing between "watch
   * your own session" and "watch anyone's".
   */
  private async handleAgentRunEvents(req: IncomingMessage, res: ServerResponse, url: URL, runId: string): Promise<void> {
    if (!this.agentChannel?.subscribeLive || !this.sessionStore) {
      res.writeHead(404).end();
      return;
    }
    if (!bearerToken(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    const record = sessionId ? await this.sessionStore.get(sessionId) : undefined;
    if (!sessionId || record?.lastAgentRunId !== runId) {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders?.();

    const live = this.agentChannel.subscribeLive(runId, (msg) => {
      if (msg.type === "opencode_event") {
        res.write(`data: ${JSON.stringify(msg.event ?? null)}\n\n`);
      } else if (msg.type === "session_ended") {
        res.write(`event: session_ended\ndata: ${JSON.stringify({ reason: msg.reason })}\n\n`);
        res.end();
      }
    });
    req.on("close", () => live.unsubscribe());
  }

  /**
   * `POST /agent-runs/:runId/opencode?sessionId=...` -> forwards
   * `{ method, path, body? }` into the run's local opencode server and
   * returns `{ status, body? }` (ADR 0026). Same session/runId cross-check
   * as `handleAgentRunEvents`.
   */
  private async handleAgentRunOpencode(req: IncomingMessage, res: ServerResponse, url: URL, runId: string): Promise<void> {
    if (!this.agentChannel?.forwardOpencodeRequest || !this.sessionStore) {
      res.writeHead(404).end();
      return;
    }
    if (!bearerToken(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    const record = sessionId ? await this.sessionStore.get(sessionId) : undefined;
    if (!sessionId || record?.lastAgentRunId !== runId) {
      res.writeHead(404).end();
      return;
    }

    const rawBody = await readBody(req);
    let parsed: { method?: unknown; path?: unknown; body?: unknown };
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as typeof parsed) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "body must be JSON" }));
      return;
    }
    if (typeof parsed.method !== "string" || typeof parsed.path !== "string") {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ error: '"method" and "path" are required strings' }),
      );
      return;
    }

    try {
      const result = await this.agentChannel.forwardOpencodeRequest(runId, {
        method: parsed.method,
        path: parsed.path,
        body: parsed.body,
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" }).end(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  private async handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);

    let request: string;
    let sessionId: string | undefined;
    let identityLinkFlow: "device" | "authcode" | undefined;
    let forcedSkillId: string | undefined;
    let forcedAgentId: string | undefined;
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
      // Power-user/headless-caller convenience field, not required -- an
      // absent or invalid value is silently ignored (the graph's own
      // "authcode" default applies) rather than 400ing the whole request.
      const rawFlow = (parsed as { identity_link_flow?: unknown }).identity_link_flow;
      identityLinkFlow = rawFlow === "device" || rawFlow === "authcode" ? rawFlow : undefined;

      // Optional event descriptor (e.g. { source: "github", event: "issues",
      // action: "assigned", owner, repo, issueNumber, ... }) -- an adapter
      // (integration-gateway) sends this alongside `request` when the
      // inbound trigger already names an unambiguous target via an
      // IntegrationRoute CR, so this call can bypass RAG skill retrieval
      // entirely. No match (or no `event` at all) leaves `request` as the
      // request text and behaves exactly as before this field existed.
      const rawEvent = (parsed as { event?: unknown }).event;
      if (this.integrationRouteRegistry && rawEvent && typeof rawEvent === "object") {
        const eventFields = rawEvent as Record<string, unknown>;
        const source = eventFields.source;
        const eventName = eventFields.event;
        const action = eventFields.action;
        if (typeof source === "string" && typeof eventName === "string") {
          const route = this.integrationRouteRegistry.match(
            source,
            eventName,
            typeof action === "string" ? action : undefined,
          );
          if (route) {
            request = renderPromptTemplate(
              route.promptTemplate,
              eventFields as Record<string, string | number | undefined>,
            );
            forcedSkillId = route.skillRef;
            forcedAgentId = route.agentRef;
          }
        }
      }
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
    void this.buildGraphInput(
      request,
      authToken,
      sessionId,
      // Deliberately `undefined` -- this is a fire-and-forget caller with no
      // live channel, so `progressListener` must stay unset here (see its
      // doc and `remoteControlUrlListener`'s doc below for why: setting it
      // makes `delegateToAgent` treat this as a live channel and
      // synchronously `waitForCompletion` an identity link for minutes,
      // which is exactly the regression that caused a real triage turn to
      // silently hang with nothing posted to the issue).
      undefined,
      identityLinkFlow,
      undefined,
      forcedSkillId,
      forcedAgentId,
      // Tracks the latest "remote-control-url" progress message onto this
      // invocation's record (see `InvocationRecord.remoteControlUrl`) --
      // passed via the dedicated `remoteControlUrlListener` param, NOT
      // `progressListener` (see above). Only mutate while still pending --
      // never clobber a terminal record (mirrors `reportIdentityLinkPending`
      // below).
      (url) => {
        const current = this.invocations.get(id);
        if (current && current.status === "pending") {
          this.invocations.set(id, { ...current, remoteControlUrl: url });
        }
      },
    ).then((graphInput) => {
      // Mark the in-flight job identity-link-pending the moment the graph
      // decides a link is needed (before the link URL exists), so a polling
      // caller can withhold a premature "starting work" ack. Only mutate while
      // still pending -- never clobber a terminal record.
      graphInput.reportIdentityLinkPending = (info) => {
        const current = this.invocations.get(id);
        if (current && current.status === "pending") {
          this.invocations.set(id, { ...current, identityLinkPending: true, identityLink: info });
        }
      };
      return this.graph
        .invoke(graphInput)
        .then(async (state) => {
          await this.persistSession(sessionId, state.identity, {
            selectedSkill: state.selectedSkill,
            selectedAgent: state.selectedAgent,
            agentRunId: state.agentRunId,
            agentAwaitingReply: state.agentAwaitingReply,
            extractedContinuation: state.extractedContinuation,
            extractedAgentContinuation: state.extractedAgentContinuation,
            pendingIdentityLink: state.pendingIdentityLink,
            identityLinkPending: state.identityLinkPending,
          });
          // Carry forward any remoteControlUrl already recorded by the
          // progress listener above -- this terminal write replaces the whole
          // record, so it would otherwise be dropped on a successful/failed turn.
          const remoteControlUrl = this.invocations.get(id)?.remoteControlUrl;
          this.invocations.set(id, {
            id,
            status: state.error ? "failed" : "succeeded",
            result: state.result,
            error: state.error,
            ...(remoteControlUrl ? { remoteControlUrl } : {}),
            ...(state.identityLinkPending && state.pendingIdentityLink && state.identity
              ? {
                  identityLinkPending: true,
                  identityLink: { provider: state.pendingIdentityLink.provider, subject: state.identity.subject },
                }
              : {}),
          });
        })
        .catch((err: unknown) => {
          const remoteControlUrl = this.invocations.get(id)?.remoteControlUrl;
          this.invocations.set(id, {
            id,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            ...(remoteControlUrl ? { remoteControlUrl } : {}),
          });
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
    const forwardedUserToken = headerValue(req.headers[FORWARDED_USER_JWT_HEADER]);
    const stream = parsed.stream === true;

    // Open WebUI's own housekeeping completions (title/tags/query/follow-up
    // generation) must NEVER reach the agent graph — see
    // isInternalUiTaskRequest. Answered directly, with no delegation, no
    // identity resolution, and no session mutation, regardless of `stream`.
    if (isInternalUiTaskRequest(request)) {
      await this.handleInternalUiTask(res, parsed.messages, model, stream);
      return;
    }

    if (!stream) {
      await this.handleChatCompletionsBlocking(res, request, model, authToken, sessionId, forwardedUserToken);
      return;
    }
    await this.handleChatCompletionsStreaming(res, request, model, authToken, sessionId, forwardedUserToken);
  }

  /**
   * Answers an Open WebUI internal housekeeping request (see
   * `isInternalUiTaskRequest`) with a direct, non-agentic completion —
   * bypassing the agent graph entirely. Falls back to a generic static reply
   * when no `taskCompleter` is configured; safety (never delegating) matters
   * more here than title quality.
   */
  private async handleInternalUiTask(
    res: ServerResponse,
    messages: unknown,
    model: string,
    stream: boolean,
  ): Promise<void> {
    let content: string;
    try {
      content = this.taskCompleter ? await this.taskCompleter.complete(messages, model) : "";
    } catch {
      content = "";
    }
    const id = chatCompletionId();
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(chatCompletionResponse(id, model, content, "stop")),
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();
    writeSseChunk(res, chatCompletionChunk(id, model, { content }, null));
    writeSseChunk(res, chatCompletionChunk(id, model, {}, "stop"));
    writeSseDone(res);
    res.end();
  }

  private async handleChatCompletionsBlocking(
    res: ServerResponse,
    request: string,
    model: string,
    authToken: string,
    sessionId: string | undefined,
    forwardedUserToken?: string,
  ): Promise<void> {
    const graphInput = await this.buildGraphInput(request, authToken, sessionId, undefined, undefined, forwardedUserToken);
    const state = await this.graph.invoke(graphInput);
    if (state.error) {
      const { status, code } = errorStatusAndCode(state.error);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(openAiError(state.error, code)));
      return;
    }
    await this.persistSession(sessionId, state.identity, {
      selectedSkill: state.selectedSkill,
      selectedAgent: state.selectedAgent,
      agentRunId: state.agentRunId,
      agentAwaitingReply: state.agentAwaitingReply,
      extractedContinuation: state.extractedContinuation,
      extractedAgentContinuation: state.extractedAgentContinuation,
      pendingIdentityLink: state.pendingIdentityLink,
      identityLinkPending: state.identityLinkPending,
    });
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
    forwardedUserToken?: string,
  ): Promise<void> {
    const id = chatCompletionId();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    // Tracks the most recent in-progress ("done: false") status step so it
    // can be closed out before the stream ends -- otherwise Open WebUI's
    // StatusHistory spinner is left stuck on that step forever, since a
    // "done: false" event is never followed by a matching "done: true" one
    // for the same step once the agent turn completes.
    let openStatusLabel: string | undefined;
    const finish = (content: string): void => {
      if (openStatusLabel !== undefined) {
        writeSseStatus(res, openStatusLabel, true);
        openStatusLabel = undefined;
      }
      writeSseChunk(res, chatCompletionChunk(id, model, { content }, null));
      writeSseChunk(res, chatCompletionChunk(id, model, {}, "stop"));
      writeSseDone(res);
      res.end();
    };

    try {
      const graphInput = await this.buildGraphInput(request, authToken, sessionId, (stage, message) => {
        // "agent-text" (opencode-swe-agent/src/index.ts) is the delegated
        // agent's own narrative — its actual reasoning/commentary as it
        // works. Stream that live as real chat content so the user reads it
        // like normal assistant prose, rather than burying it in the
        // collapsible status spinner with the mechanical tool-call noise.
        // "identity-link" (agent/graph.ts's delegateToAgent) is the one-time
        // "please link your GitHub account" prompt -- also real content, not
        // a status step, since the status label is truncated to 120 chars
        // and would mangle the markdown link/URL.
        if ((stage === "agent-text" || stage === "identity-link") && message) {
          writeSseChunk(res, chatCompletionChunk(id, model, { content: message }, null));
          return;
        }
        // Everything else (tool invocations, warnings, pipeline stage
        // transitions) is mechanical bookkeeping -- an Open WebUI status step
        // (collapsible StatusHistory spinner) while the Job runs.
        const label = message
          ? `${stage ? `${stage}: ` : ""}${message.slice(0, 120)}`
          : stage || "working…";
        openStatusLabel = label;
        writeSseStatus(res, label, false);
      }, undefined, forwardedUserToken);
      const source = await this.graph.stream(graphInput, { streamMode: "updates" });
      // Accumulated across updates so the session can be persisted once the
      // turn reaches a successful terminal node (docs/adr/0012).
      let identity: { subject: string } | undefined;
      let selectedSkill: { id: string } | undefined;
      let selectedAgent: { id: string } | undefined;
      let agentRunId: string | undefined;
      let agentAwaitingReply: boolean | undefined;
      let skillContinuation = false; // true when checkActiveSkill confirmed an existing session skill
      // The tool result is produced by `runTool` and may then be left as-is or
      // wrapped by `composeResponse` (docs/adr/0015). composeResponse emits an
      // empty update when it adds no narration, so track the latest result
      // rather than reading it off the terminal node's update alone.
      let result: unknown;
      let extractedContinuation: { toolId: string; token: string } | undefined;
      let extractedAgentContinuation: { agentId: string; token: string } | undefined;
      let pendingIdentityLink:
        | { agentId: string; provider: string; flow: "device" | "authcode" | "page"; deviceCode?: string; expiresAt: number }
        | undefined;
      let identityLinkPending: boolean | undefined;
      const persist = (): Promise<void> =>
        this.persistSession(sessionId, identity, {
          selectedSkill,
          selectedAgent,
          agentRunId,
          agentAwaitingReply,
          extractedContinuation,
          extractedAgentContinuation,
          pendingIdentityLink,
          identityLinkPending,
        });
      for await (const item of withHeartbeat(source, HEARTBEAT_MS)) {
        if (item.type === "heartbeat") {
          writeSseComment(res, "keep-alive");
          continue;
        }
        const [nodeName, update] = Object.entries(item.value)[0] as [string, Record<string, unknown>];
        if (update.identity) identity = update.identity as { subject: string };
        if (update.selectedSkill) selectedSkill = update.selectedSkill as { id: string };
        if (update.selectedAgent) selectedAgent = update.selectedAgent as { id: string };
        if ("agentRunId" in update) agentRunId = update.agentRunId as string | undefined;
        if ("agentAwaitingReply" in update) agentAwaitingReply = update.agentAwaitingReply as boolean | undefined;
        if (nodeName === "checkActiveSkill" && update.selectedSkill) skillContinuation = true;
        if ("result" in update) result = update.result;
        if ("extractedContinuation" in update) {
          extractedContinuation = update.extractedContinuation as { toolId: string; token: string } | undefined;
        }
        if ("extractedAgentContinuation" in update) {
          extractedAgentContinuation = update.extractedAgentContinuation as
            | { agentId: string; token: string }
            | undefined;
        }
        if ("pendingIdentityLink" in update) {
          pendingIdentityLink = update.pendingIdentityLink as
            | { agentId: string; provider: string; flow: "device" | "authcode" | "page"; deviceCode?: string; expiresAt: number }
            | undefined;
        }
        if ("identityLinkPending" in update) identityLinkPending = update.identityLinkPending as boolean | undefined;

        if (typeof update.error === "string") {
          finish(`❌ ${update.error}`);
          return;
        }
        // checkPendingIdentityLink (still waiting on an existing device-flow
        // attempt) and delegateToAgent (just started a FRESH one) are both
        // terminal for this graph invocation whenever identityLinkPending is
        // true -- `result` is the "please link/still waiting" message, set
        // directly on the node, with no agentRunId (no AgentRun was ever
        // launched yet).
        if ((nodeName === "checkPendingIdentityLink" || nodeName === "delegateToAgent") && identityLinkPending) {
          await persist();
          finish(renderResult(result));
          return;
        }
        if (nodeName === "composeResponse") {
          await persist();
          finish(renderResult(result));
          return;
        }
        // planAction is also terminal when the planner chose "respond"
        // (no tool call, e.g. asking the user to paste the recipe back) —
        // `result` is set and the graph routes straight to END without ever
        // reaching runTool, so this must be treated as terminal here too.
        if (nodeName === "planAction" && update.result !== undefined) {
          await persist();
          finish(renderResult(update.result));
          return;
        }
        // selectDelegate is also terminal when noMatchFallback produced a
        // bare best-effort LLM answer (no skill, tool, or agent selected at
        // all — graph.ts's true last resort for a request matching nothing
        // in the catalog) — `result` is set directly on this node and the
        // graph routes straight to END without ever reaching runTool or
        // composeResponse.
        if (nodeName === "selectDelegate" && update.result !== undefined) {
          await persist();
          finish(renderResult(update.result));
          return;
        }
        // bareAnswer is terminal when the capability-need gate (docs/adr/0019)
        // judged the request needs no skill/tool/agent at all — a plain
        // conversational answer with no catalog search ever attempted.
        // `result` is set directly on this node and the graph routes
        // straight to END.
        if (nodeName === "bareAnswer" && update.result !== undefined) {
          await persist();
          finish(renderResult(update.result));
          return;
        }
        // delegateToAgent and checkActiveAgentRun (continuation) are always
        // terminal for this graph invocation when they set an agentRunId — a
        // question, a final reply, or a failure all end the turn.
        if ((nodeName === "delegateToAgent" || nodeName === "checkActiveAgentRun") && update.agentRunId) {
          await persist();
          finish(renderResult(result));
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
