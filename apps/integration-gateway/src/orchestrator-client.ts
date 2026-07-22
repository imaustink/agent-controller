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
  token: string;
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

export class OrchestratorClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OrchestratorClientOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
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
        authorization: `Bearer ${this.options.token}`,
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
        { headers: { authorization: `Bearer ${this.options.token}` } },
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
}
