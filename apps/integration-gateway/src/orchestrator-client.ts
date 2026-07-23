/**
 * Thin client for agent-orchestrator's existing consumer-facing async
 * accept/poll interface (ADR 0006): `POST /invoke` -> `202 { id }`,
 * `GET /invoke/:id` -> `{ status, result?, error? }`.
 *
 * The gateway deliberately does NOT launch a ToolRun/AgentRun itself for the
 * GitHub conversational path -- it reuses the orchestrator's existing RAG
 * skill-retrieval turn (`session_id` scoped to the issue), which already
 * implements the "ask a clarifying question, then resume on the next turn"
 * behavior via `checkActiveAgentRun`/`AgentSession.ask()`.
 *
 * Polling here is a deliberate stand-in for the "gateway registers its own
 * callback URL with the orchestrator" extension flagged as an open question
 * in docs/integrations-gateway.md -- push-based delivery is a documented
 * follow-up, not built in this phase.
 */
export interface OrchestratorInvokeResult {
  status: "succeeded" | "failed" | "timed_out";
  result?: string;
  error?: string;
  /** True when this turn's `result` is an "link your account" prompt rather than finished work -- the caller needs the linked identity before any agent runs (see agent-orchestrator's `InvocationRecord.identityLinkPending`). */
  identityLinkPending?: boolean;
  /** Provider + subject the pending link is keyed on, for a caller that can wait on its own token store and auto-resume once linked. Present only alongside `identityLinkPending`. */
  identityLink?: { provider: string; subject: string };
}

export interface OrchestratorClientOptions {
  baseUrl: string;
  /**
   * Either a static bearer token, or a function resolving one on demand
   * (e.g. `OidcTokenProvider.getToken`, which caches and transparently
   * refreshes a short-lived OIDC client_credentials token). Resolved fresh
   * before every HTTP call (both the initial accept and each poll), so a
   * dynamic provider's caching/refresh logic governs whether that's a cheap
   * cache hit or an actual token refresh -- important since a single
   * `invoke()` can poll for up to `pollTimeoutMs` (default 15 minutes),
   * comfortably longer than a token's lifetime.
   */
  token: string | (() => Promise<string>);
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

interface InvokeAcceptedBody {
  id: string;
}

interface InvokePollBody {
  status: "pending" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
  identityLinkPending?: boolean;
  identityLink?: { provider: string; subject: string };
}

/** Result of `checkLive` (ADR 0026). */
export interface LiveStatus {
  live: boolean;
  agentRunId?: string;
}

/** Result of a forwarded opencode call via `forwardOpencode` (ADR 0026). */
export interface OpencodeForwardResult {
  status: number;
  body?: unknown;
}

export class OrchestratorClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OrchestratorClientOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private resolveToken(): Promise<string> | string {
    return typeof this.options.token === "function" ? this.options.token() : this.options.token;
  }

  private baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, "");
  }

  /**
   * Checks whether `sessionId`'s most recent agent run is still resident and
   * tunnelable (ADR 0026), via agent-orchestrator's `GET /sessions/live` --
   * a real-time probe on the orchestrator's end, not a cached flag, so this
   * always reflects whether the Pod is ACTUALLY reachable right now.
   */
  async checkLive(sessionId: string): Promise<LiveStatus> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl()}/sessions/live?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${await this.resolveToken()}` },
      });
      if (!res.ok) return { live: false };
      return (await res.json()) as LiveStatus;
    } catch {
      return { live: false };
    }
  }

  /**
   * Opens agent-orchestrator's `GET /agent-runs/:runId/events` SSE stream
   * (ADR 0026) and returns the raw `Response` so the caller can pipe its
   * body straight through to its own client -- proxying, not buffering.
   */
  async openEventStream(runId: string, sessionId: string): Promise<Response> {
    return this.fetchImpl(
      `${this.baseUrl()}/agent-runs/${encodeURIComponent(runId)}/events?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Bearer ${await this.resolveToken()}`, accept: "text/event-stream" } },
    );
  }

  /**
   * Forwards an HTTP call into `runId`'s local opencode server via
   * agent-orchestrator's `POST /agent-runs/:runId/opencode` (ADR 0026).
   */
  async forwardOpencode(
    runId: string,
    sessionId: string,
    req: { method: string; path: string; body?: unknown },
  ): Promise<OpencodeForwardResult> {
    const res = await this.fetchImpl(
      `${this.baseUrl()}/agent-runs/${encodeURIComponent(runId)}/opencode?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await this.resolveToken()}` },
        body: JSON.stringify(req),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`forwardOpencode failed: ${res.status} ${text}`);
    let parsed: OpencodeForwardResult;
    try {
      parsed = JSON.parse(text) as OpencodeForwardResult;
    } catch {
      throw new Error(`forwardOpencode returned non-JSON: ${text}`);
    }
    return parsed;
  }

  /**
   * Starts a new turn (or resumes an existing session's active agent run)
   * and awaits its terminal result. `identityLinkFlow`, when set, is passed
   * through as `identity_link_flow` so agent-orchestrator knows which
   * identity-link flow to offer this caller (e.g. this gateway's own
   * GitHub-issue-comment relay has no browser, so it always forces
   * `"device"`) -- omitted entirely (not sent as `null`) when unset, so
   * agent-orchestrator's own default applies. `event`, when set, is passed
   * through verbatim as the `event` body field so agent-orchestrator can
   * match it against an installed `IntegrationRoute` CR and bypass RAG skill
   * retrieval for triggers whose intent is already unambiguous (e.g. a
   * GitHub issue assigned to the bot) -- omitted entirely when unset, same
   * as `identityLinkFlow`.
   */
  async invoke(
    request: string,
    sessionId: string,
    identityLinkFlow?: "device" | "authcode",
    event?: Record<string, string | number | undefined>,
    /**
     * Fired at most once, the first poll that shows the turn genuinely
     * running (status `pending` and NOT identity-link-pending) -- i.e. past
     * the auth pre-flight, an agent actually launching. A caller uses this to
     * post a "starting work" acknowledgement only when work has really begun,
     * withholding it while an identity link is still being set up. Never fired
     * for a turn that ends up identity-link-pending.
     */
    onRunning?: () => void | Promise<void>,
  ): Promise<OrchestratorInvokeResult> {
    const acceptRes = await this.fetchImpl(`${this.baseUrl()}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await this.resolveToken()}`,
      },
      body: JSON.stringify({
        request,
        session_id: sessionId,
        ...(identityLinkFlow !== undefined ? { identity_link_flow: identityLinkFlow } : {}),
        ...(event !== undefined ? { event } : {}),
      }),
    });
    if (!acceptRes.ok) {
      return { status: "failed", error: `/invoke rejected the request: ${acceptRes.status} ${await acceptRes.text()}` };
    }
    const accepted = (await acceptRes.json()) as InvokeAcceptedBody;

    const deadline = Date.now() + this.options.pollTimeoutMs;
    let announcedRunning = false;
    while (Date.now() < deadline) {
      await this.sleep(this.options.pollIntervalMs);
      const pollRes = await this.fetchImpl(
        `${this.baseUrl()}/invoke/${accepted.id}`,
        { headers: { authorization: `Bearer ${await this.resolveToken()}` } },
      );
      if (!pollRes.ok) {
        return { status: "failed", error: `/invoke/${accepted.id} poll failed: ${pollRes.status}` };
      }
      const polled = (await pollRes.json()) as InvokePollBody;
      if (polled.status === "succeeded") {
        return {
          status: "succeeded",
          result: typeof polled.result === "string" ? polled.result : JSON.stringify(polled.result),
          identityLinkPending: polled.identityLinkPending,
          identityLink: polled.identityLink,
        };
      }
      if (polled.status === "failed") {
        return { status: "failed", error: polled.error ?? "orchestrator turn failed" };
      }
      // status === "pending". Announce "running" the first time we see the
      // turn is past its auth pre-flight (not identity-link-pending) -- an
      // agent is genuinely launching, so it's honest to say work has started.
      // While identityLinkPending is still set, hold the announcement back.
      if (!announcedRunning && !polled.identityLinkPending) {
        announcedRunning = true;
        await onRunning?.();
      }
      // keep polling.
    }
    return { status: "timed_out", error: `no terminal result within ${this.options.pollTimeoutMs}ms` };
  }
}
