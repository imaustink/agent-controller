import { SENDER_ASSERTION_HEADER, mintSenderAssertion } from "../rbac/sender-assertion.js";
import { CALLER_IDENTITY_HEADER, mintCallerIdentityAssertion } from "../rbac/caller-identity-assertion.js";
import type { AgentGraphInput, AgentGraphLike } from "../server.js";
import type { AgentState } from "../agent/graph.js";
import type { IdentityResolver } from "../rbac/types.js";
import { CALLER_TOOL_ID_PREFIX } from "../caller-tools/types.js";

/**
 * Runs a turn on the Temporal engine (`engines/temporal`) instead of the
 * in-process LangGraph graph — the `AGENT_ENGINE=temporal` half of the switch.
 *
 * ## Why this is an HTTP client and not a Temporal client
 *
 * The obvious implementation embeds `@temporalio/client` and does
 * update-with-start from this process. It was rejected for three reasons, in
 * ascending order of importance:
 *
 * 1. It adds a substantial npm dependency to an app that needs one HTTP call.
 * 2. The engine's Go gateway already implements exactly this contract —
 *    `POST /invoke` returns an id, `GET /invoke/:id` reports on it — and
 *    reimplementing the same accept/poll semantics in TypeScript would give two
 *    definitions of one protocol.
 * 3. It would put Temporal credentials in the orchestrator pod, which is the pod
 *    that already holds the Kubernetes identity. `docs/orchestrator.md` reasons
 *    explicitly about that pod's blast radius; leaving it unchanged is worth an
 *    extra network hop.
 *
 * ## What this engine does NOT return
 *
 * The graph's `AgentState` carries the session fields `persistSession` writes:
 * `selectedSkill`, `agentRunId`, `pendingIdentityLink`, `extractedContinuation`
 * and the rest. This engine returns none of them, deliberately — the workflow
 * holds that state itself (docs/adr/0001), which is the entire point of the
 * change. `persistSession` treats every one as optional and merges rather than
 * replaces, so an all-undefined outcome is a no-op rather than a clobber.
 *
 * Concretely that means a conversation running on this engine keeps its skill
 * continuity, continuation tokens and pending links inside the workflow, and
 * the Redis session record simply stays empty for it. Switching a live
 * conversation between engines mid-flight would lose that state — which is why
 * the flag is process-wide rather than per-request.
 */
export interface TemporalEngineOptions {
  /** Base URL of the engine's gateway Service, e.g. `http://temporal-engine-gateway:8080`. */
  baseUrl: string;
  /** Bearer token presented to the gateway, if it resolves identities by token. */
  token?: string;
  /**
   * Shared secret for the sender assertion. Without it a webhook-driven turn
   * reaches the engine with no principal, so cross-entry-point credential
   * sharing degrades — the same documented weaker mode as the gateway hop.
   */
  senderAssertionSecret?: string;
  /**
   * Resolves Open WebUI's per-request signed user JWT into a real per-user
   * identity (the SAME resolver the LangGraph engine's `resolveIdentity` node
   * uses for `state.forwardedUserToken`) -- needed because the gateway
   * otherwise only ever sees ONE shared service identity for every internal
   * hop, which would collapse every Open WebUI user onto that one subject.
   * Deliberately NOT a general authToken-based resolver: every OTHER caller of
   * this process's own /invoke (a webhook relay, a static-token programmatic
   * caller) shares one token that says nothing about who is actually asking,
   * and forwarding an identity resolved from it would override the subject a
   * webhook turn's own senderLogin/sender-assertion channel already handles.
   * Absent -> every chat turn on this engine resolves the gateway's own
   * default/bearer identity, same as before this existed.
   */
  forwardedUserIdentityResolver?: IdentityResolver;
  /** How long to keep polling one turn before giving up. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Poll interval. The engine's own poll route already waits ~2s server-side, so this is only the gap between waits. */
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

interface InvokeAccepted {
  id: string;
  status: string;
}

interface InvokeRecord {
  id: string;
  status: "pending" | "succeeded" | "failed";
  result?: string;
  error?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

export class TemporalEngine implements AgentGraphLike {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TemporalEngineOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async invoke(input: AgentGraphInput): Promise<AgentState> {
    const id = await this.start(input);
    const record = await this.poll(id, input);

    if (record.status === "failed") {
      return { ...input, error: record.error ?? "the turn failed" } as AgentState;
    }
    if (record.toolCalls?.length) {
      // The second non-error terminal shape (docs/adr/0035): the caller's own
      // client has to run these.
      return {
        ...input,
        pendingToolCalls: record.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      } as AgentState;
    }
    return { ...input, result: record.result } as AgentState;
  }

  /**
   * Yields one terminal update, so a streaming caller still gets its answer.
   *
   * No per-node narration: those lines describe LangGraph node transitions,
   * which do not exist here. The engine narrates its own turns over its own
   * progress query, and plumbing that through this hop would mean a second
   * streaming protocol for a status line. A streaming client on this engine
   * therefore sees the reply rather than the running commentary — a real
   * difference, recorded rather than papered over.
   */
  async stream(
    input: AgentGraphInput,
    _options: { streamMode: "updates" },
  ): Promise<AsyncIterable<Record<string, Partial<AgentState>>>> {
    const state = await this.invoke(input);
    return {
      async *[Symbol.asyncIterator]() {
        yield { temporalEngine: state };
      },
    };
  }

  private async start(input: AgentGraphInput): Promise<string> {
    const headers = this.headers();

    // The sender login travels as a SIGNED assertion, not a body field —
    // reusing the same `x-gateway-user-assertion` contract integration-gateway
    // already uses (docs/adr/0030 §6), whose Go verifier is byte-compatible
    // with `mintSenderAssertion`. It selects the caller's principal, and hence
    // which stored credentials the run receives, so an internal hop is exactly
    // as unsuited to trusting it unsigned as an external one.
    if (input.senderLogin && this.options.senderAssertionSecret) {
      headers[SENDER_ASSERTION_HEADER] = mintSenderAssertion(this.options.senderAssertionSecret, input.senderLogin);
    }

    // This process's OWN per-request identity resolution (OIDC/static/
    // forwarded-user-JWT), signed across the hop -- without this, every
    // caller of /invoke resolves to the SAME gateway-default/bearer subject
    // regardless of which human triggered the turn, which is exactly the
    // collapsed-identity bug ADR 0030 fixed for webhooks. Mirrors graph.ts's
    // resolveIdentity node: prefer the forwarded-user JWT over the shared
    // static authToken when both are available.
    // Scoped to the forwarded-user-JWT path ONLY, deliberately -- not a
    // general "resolve identity somehow" fallback. `input.authToken` alone is
    // ONE value every caller of this process's own /invoke shares (Open WebUI's
    // shared bearer token, integration-gateway's static service token for a
    // relayed webhook turn, etc.), so resolving it says nothing about who is
    // actually asking and would override the correctly-defaulted gateway
    // subject that a webhook turn's OWN senderLogin/sender-assertion channel
    // already handles -- regressing every webhook-driven turn's credential
    // resolution the moment this identity resolves to anything at all.
    if (this.options.senderAssertionSecret && input.forwardedUserToken && this.options.forwardedUserIdentityResolver) {
      const identity = await this.options.forwardedUserIdentityResolver.resolve(input.forwardedUserToken);
      if (identity) {
        headers[CALLER_IDENTITY_HEADER] = mintCallerIdentityAssertion(
          this.options.senderAssertionSecret,
          identity.subject,
          identity.roles,
          true,
        );
      }
    }

    const res = await this.fetchImpl(`${this.baseUrl}/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        request: input.request,
        sessionId: input.sessionId,
        // This process owns the IntegrationRoute registry and has already
        // matched it, so the target is named rather than re-derived. The engine
        // still re-resolves it under the caller's own roles.
        ...(input.forcedSkillId ? { forcedSkillId: input.forcedSkillId } : {}),
        ...(input.forcedAgentId ? { forcedAgentId: input.forcedAgentId } : {}),
        // Already resolved, validated and top-K-ranked by this process's own
        // handleChat pipeline (ADR 0035) before invoke() is ever called --
        // the engine's /invoke takes the resolved Descriptor shape (each
        // ToolDescriptor's nested `callerTool`), not a raw OpenAI tools array,
        // and re-ranks nothing. Omitting this silently drops every caller
        // tool for any turn routed through this engine.
        ...(input.callerTools?.length
          ? { callerTools: input.callerTools.map((t) => t.callerTool).filter(Boolean) }
          : {}),
        ...(input.callerToolChoiceRequired ? { callerToolRequired: true } : {}),
        // Prior client-executed calls (ADR 0035 resume), the same
        // strip-the-namespace transform as everywhere else a caller-tool id
        // crosses back out of the `caller:` namespace -- the engine's own
        // callertools.ID re-adds it, so forwarding it prefixed would double it.
        ...(input.actionHistory?.length
          ? {
              priorCallerToolCalls: input.actionHistory.map((call) => ({
                name: call.toolId.startsWith(CALLER_TOOL_ID_PREFIX)
                  ? call.toolId.slice(CALLER_TOOL_ID_PREFIX.length)
                  : call.toolId,
                arguments: call.toolArgs,
                result: call.result,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`temporal engine /invoke failed: ${res.status}`);
    }
    return ((await res.json()) as InvokeAccepted).id;
  }

  private async poll(id: string, input: AgentGraphInput): Promise<InvokeRecord> {
    const deadline = Date.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}/invoke/${encodeURIComponent(id)}`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        throw new Error(`temporal engine /invoke/${id} failed: ${res.status}`);
      }
      const record = (await res.json()) as InvokeRecord;
      if (record.status !== "pending") return record;

      if (Date.now() >= deadline) {
        // Deliberately not an engine error: the turn is still running and its
        // answer stays collectable, because the record IS the workflow rather
        // than this process's memory. Reported as a resumable pause, the same
        // shape docs/adr/0033 settled on for an interrupted turn.
        return {
          id,
          status: "succeeded",
          result:
            "That's taking longer than I can wait here — it's still running, " +
            "and I'll have the answer on your next message.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      void input;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    return headers;
  }
}
