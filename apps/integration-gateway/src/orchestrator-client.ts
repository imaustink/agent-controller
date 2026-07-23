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
}

/** One entry in `SessionView.transcript` -- mirrors agent-orchestrator's `SessionTranscriptEntry`. */
export interface SessionTranscriptEntry {
  role: "user" | "agent";
  text: string;
  at: number;
}

/** Body shape of agent-orchestrator's `GET /sessions/:sessionId` (see its server.ts). */
export interface SessionView {
  sessionId: string;
  pending: boolean;
  activeSkillId?: string;
  activeAgentId?: string;
  activeAgentRunId?: string;
  updatedAt?: number;
  transcript: SessionTranscriptEntry[];
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
  ): Promise<OrchestratorInvokeResult> {
    const acceptRes = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/invoke`, {
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
    while (Date.now() < deadline) {
      await this.sleep(this.options.pollIntervalMs);
      const pollRes = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, "")}/invoke/${accepted.id}`,
        { headers: { authorization: `Bearer ${await this.resolveToken()}` } },
      );
      if (!pollRes.ok) {
        return { status: "failed", error: `/invoke/${accepted.id} poll failed: ${pollRes.status}` };
      }
      const polled = (await pollRes.json()) as InvokePollBody;
      if (polled.status === "succeeded") {
        return { status: "succeeded", result: typeof polled.result === "string" ? polled.result : JSON.stringify(polled.result) };
      }
      if (polled.status === "failed") {
        return { status: "failed", error: polled.error ?? "orchestrator turn failed" };
      }
      // status === "pending" -- keep polling.
    }
    return { status: "timed_out", error: `no terminal result within ${this.options.pollTimeoutMs}ms` };
  }

  /**
   * Service-to-service read of a session's current state/transcript, for the
   * session-viewer page (`GET /sessions/:sessionId` on this gateway, see
   * server.ts). Uses the same bearer token this client already
   * authenticates its `/invoke` calls with -- agent-orchestrator's
   * `GET /sessions/:sessionId` is not itself internet-facing, only reachable
   * from trusted in-cluster callers like this one. Returns `undefined` on a
   * 404 (unknown session, or the orchestrator has no session store
   * configured) or any other non-2xx response, rather than throwing --
   * callers treat "no session data available" as a normal, displayable
   * state, not an error.
   */
  async getSession(sessionId: string): Promise<SessionView | undefined> {
    const res = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Bearer ${await this.resolveToken()}` } },
    );
    if (!res.ok) return undefined;
    return (await res.json()) as SessionView;
  }
}
