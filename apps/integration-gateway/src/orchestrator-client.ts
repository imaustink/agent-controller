/**
 * Thin client for agent-orchestrator's consumer-facing async accept/poll
 * interface (ADR 0006): `POST /invoke` -> `202 { id }`, `GET /invoke/:id` ->
 * `{ status, result?, error? }`. Events (ADR 0048, docs/event-triggers.md §5)
 * ride the same endpoint with an `event` envelope instead of a `request`
 * string; matching and dispatch are entirely the orchestrator's -- the
 * gateway never launches a ToolRun/AgentRun itself.
 *
 * Polling here is a deliberate stand-in for the "gateway registers its own
 * callback URL with the orchestrator" extension flagged as an open question
 * in docs/integrations-gateway.md -- push-based delivery is a documented
 * follow-up, not built in this phase.
 */

import type { Envelope, RenderedReply } from "@controller-agent/event-triggers";
import { SENDER_ASSERTION_HEADER, mintSenderAssertion } from "./sender-assertion.js";

// Bounds retrying the initial POST past a transient connection failure (a
// rolling orchestrator restart) -- a few seconds total, not a general-purpose
// backoff policy.
const ACCEPT_RETRY_ATTEMPTS = 3;
const ACCEPT_RETRY_DELAY_MS = 1000;
// Consecutive poll failures tolerated before the turn is reported unreachable.
// Small on purpose: the gateway holds a relay for as long as a poll runs, so
// waiting out the whole poll budget on a dead orchestrator starves the next
// turn. A rollout gap is one kube-proxy sync (~1-2s).
const POLL_NETWORK_RETRY_LIMIT = 3;

export interface OrchestratorInvokeResult {
  status: "succeeded" | "failed" | "timed_out";
  result?: string;
  error?: string;
  /** True when this turn's `result` is an "link your account" prompt rather than finished work -- the caller needs the linked identity before any agent runs (see agent-orchestrator's `InvocationRecord.identityLinkPending`). */
  identityLinkPending?: boolean;
  /** Provider + subject the pending link is keyed on, for a caller that can wait on its own token store and auto-resume once linked. Present only alongside `identityLinkPending`. */
  identityLink?: { provider: string; subject: string };
  /**
   * A Remote Control session URL (`https://claude.ai/code/session_...`) the
   * delegated agent surfaced mid-run, if any -- see agent-orchestrator's
   * `InvocationRecord.remoteControlUrl`.
   */
  remoteControlUrl?: string;
}

export interface OrchestratorClientOptions {
  baseUrl: string;
  /**
   * Signs the sender assertion accompanying an `/invoke` that carries a
   * verified sender login (docs/adr/0030 §6). Absent -> no assertion header is
   * ever sent.
   */
  senderAssertionSecret?: string;
  /**
   * Either a static bearer token, or a function resolving one on demand
   * (e.g. `OidcTokenProvider.getToken`, which caches and transparently
   * refreshes a short-lived OIDC client_credentials token). Resolved fresh
   * before every HTTP call (both the initial accept and each poll), so a
   * dynamic provider's caching/refresh logic governs whether that's a cheap
   * cache hit or an actual token refresh -- important since a single turn can
   * poll for up to `pollTimeoutMs` (default 15 minutes), comfortably longer
   * than a token's lifetime.
   */
  token: string | (() => Promise<string>);
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** Optional callbacks fired while polling a turn. */
export interface PollHooks {
  /**
   * Fired at most once, the first poll that shows the turn genuinely running
   * (status `pending` and NOT identity-link-pending) -- past the auth
   * pre-flight, an agent actually launching. Never fired for a turn that ends
   * up identity-link-pending.
   */
  onRunning?: () => void | Promise<void>;
  /**
   * Fired at most once, the first poll that surfaces a Remote Control session
   * URL (agent-orchestrator's `InvocationRecord.remoteControlUrl`, only ever
   * set for an agent that emits a `remote-control-url` progress event). May
   * fire before, after, or (if no such event ever arrives) never at all.
   */
  onRemoteControlUrl?: (url: string) => void | Promise<void>;
}

/** The matched trigger an accepted event carries (docs/event-triggers.md §5). */
export interface AcceptedTrigger {
  name: string;
  sessionId: string;
  /** The trigger's `reply` with every template already rendered, or null. */
  reply: RenderedReply | null;
}

/** Outcome of {@link OrchestratorClient.submitEvent}. */
export type EventSubmitResult =
  /** 200 `{"status":"ignored"}` -- no trigger matched; no turn ran. */
  | { kind: "ignored" }
  /** 422 -- a trigger matched but its params/templates failed for this event. */
  | { kind: "rejected"; error: string }
  /** 202 -- a turn is running; poll `id`. */
  | { kind: "accepted"; id: string; trigger: AcceptedTrigger }
  /** Unreachable, or any other answer (401, 5xx, a malformed 202...). */
  | { kind: "failed"; error: string };

interface InvokePollBody {
  status: "pending" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
  identityLinkPending?: boolean;
  identityLink?: { provider: string; subject: string };
  remoteControlUrl?: string;
}

/** Result of `checkLive` (ADR 0026). */
export interface LiveStatus {
  live: boolean;
  agentRunId?: string;
}

/**
 * Result of `probeLive` (ADR 0026) -- the same real-time liveness probe as
 * {@link OrchestratorClient.checkLive}, but one that DISTINGUISHES a confirmed
 * not-live answer from an indeterminate one:
 *
 *  - `"live"`     -- a real 200 saying the run is resident/tunnelable.
 *  - `"not-live"` -- a real 200 saying it is NOT. A POSITIVE terminal signal.
 *  - `"unknown"`  -- the orchestrator could not be reached or did not answer ok
 *                    (network error, 5xx, any non-ok, or an unparseable body).
 *                    "Couldn't determine", NOT "confirmed terminal".
 *
 * `checkLive` collapses both `"not-live"` and `"unknown"` into `{ live: false }`
 * -- correct for the live-session tunnel, which only ever wants to know whether
 * to render a live badge. A caller that must not mistake a transient blip for a
 * terminal run (the label reconciler: a stripped label mid-run can spawn a
 * duplicate run) uses `probeLive` and treats only `"not-live"` as terminal.
 */
export type LiveProbe = { status: "live"; agentRunId?: string } | { status: "not-live" } | { status: "unknown" };

/** Result of a forwarded opencode call via `forwardOpencode` (ADR 0026). */
export interface OpencodeForwardResult {
  status: number;
  body?: unknown;
}

function parseAcceptedTrigger(raw: unknown): AcceptedTrigger {
  const t = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    name: typeof t.name === "string" ? t.name : "",
    sessionId: typeof t.sessionId === "string" ? t.sessionId : "",
    reply: typeof t.reply === "object" && t.reply !== null ? (t.reply as RenderedReply) : null,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    // Soft-fails both "confirmed not-live" and "couldn't determine" to
    // { live: false } -- the live-session tunnel only wants to know whether to
    // render a live badge, so the distinction is immaterial there. A caller
    // that must NOT treat a transient blip as terminal uses `probeLive`.
    const probe = await this.probeLive(sessionId);
    return probe.status === "live" ? { live: true, agentRunId: probe.agentRunId } : { live: false };
  }

  /**
   * Same probe as {@link checkLive}, but surfaces whether a not-live reading is
   * a CONFIRMED 200 ("not-live") or merely INDETERMINATE ("unknown": a network
   * error, a 5xx/non-ok, or an unparseable body). See {@link LiveProbe}. The
   * label reconciler needs this: it may only strip a label on a positive
   * terminal signal, never because the orchestrator was briefly unreachable
   * mid-run.
   */
  async probeLive(sessionId: string): Promise<LiveProbe> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl()}/sessions/live?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${await this.resolveToken()}` },
      });
      if (!res.ok) return { status: "unknown" };
      const body = (await res.json()) as LiveStatus;
      return body.live ? { status: "live", agentRunId: body.agentRunId } : { status: "not-live" };
    } catch {
      return { status: "unknown" };
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
   * The one place `POST /invoke` is sent. A REJECTED fetch (connection
   * refused/reset) is a different failure mode than a non-ok response: it
   * means the request never reached the orchestrator at all, which is exactly
   * what a rolling restart produces for the seconds between the old pod
   * terminating and the new one becoming Ready. That used to throw uncaught
   * out of the relay, so a turn landing in the window was silently dropped --
   * no comment, no retry. Retried a few times over a few seconds, well inside
   * a caller's own poll budget, since that window is normally that short.
   */
  private async postInvoke(body: Record<string, unknown>, senderLogin?: string): Promise<{ res: Response } | { networkError: unknown }> {
    const postAccept = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl()}/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await this.resolveToken()}`,
          // Signed separately from the bearer token on purpose: the token
          // authenticates THIS GATEWAY, and says nothing about which human
          // triggered the event. The login selects the caller's principal, and
          // therefore which stored credentials the run receives, so it has to
          // be something the orchestrator can verify rather than a body field
          // any holder of the token could set. Only ever minted for a login the
          // source's sender provider VERIFIED (server.ts) -- never for a login
          // merely read out of an event body.
          ...(this.options.senderAssertionSecret && senderLogin
            ? { [SENDER_ASSERTION_HEADER]: mintSenderAssertion(this.options.senderAssertionSecret, senderLogin) }
            : {}),
        },
        body: JSON.stringify(body),
      });

    let networkError: unknown;
    for (let attempt = 1; attempt <= ACCEPT_RETRY_ATTEMPTS; attempt++) {
      try {
        return { res: await postAccept() };
      } catch (err) {
        networkError = err;
        if (attempt < ACCEPT_RETRY_ATTEMPTS) await this.sleep(ACCEPT_RETRY_DELAY_MS);
      }
    }
    return { networkError };
  }

  /**
   * Relays one normalized event (docs/event-triggers.md §5): `POST /invoke`
   * with `{ event, identity_link_flow: "device" }`. The orchestrator matches
   * it against its EventTriggers and answers with one of three outcomes,
   * returned here WITHOUT polling -- the caller has to run the trigger's ack
   * and record its owed label removal between the accept and the poll, which
   * is why the two are separate calls (see {@link poll}).
   *
   * `identity_link_flow` is always "device": an event has no browser to
   * redirect, so an authcode link could never complete.
   *
   * `senderLogin` must be a VERIFIED login (the source's sender provider
   * resolved it) or absent; it is what the signed sender assertion carries.
   */
  async submitEvent(event: Envelope, senderLogin?: string): Promise<EventSubmitResult> {
    const sent = await this.postInvoke({ event, identity_link_flow: "device" }, senderLogin);
    if (!("res" in sent)) return { kind: "failed", error: `/invoke unreachable: ${errorText(sent.networkError)}` };
    const res = sent.res;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    if (res.status === 200 && body.status === "ignored") return { kind: "ignored" };
    if (res.status === 422) return { kind: "rejected", error: typeof body.error === "string" ? body.error : text || "unprocessable event" };
    if (res.status === 202 && typeof body.id === "string" && body.id) {
      return { kind: "accepted", id: body.id, trigger: parseAcceptedTrigger(body.trigger) };
    }
    return { kind: "failed", error: `/invoke answered ${res.status}: ${text}` };
  }

  /**
   * Starts an ordinary conversational turn on an existing session (or resumes
   * that session's active agent run) and awaits its terminal result -- the
   * session page's follow-up prompts. No event: the session id alone carries
   * the context. `identityLinkFlow`, when set, is passed through as
   * `identity_link_flow` (omitted, not `null`, when unset so the
   * orchestrator's own default applies).
   */
  async invoke(
    request: string,
    sessionId: string,
    identityLinkFlow?: "device" | "authcode",
    hooks: PollHooks = {},
  ): Promise<OrchestratorInvokeResult> {
    const sent = await this.postInvoke({
      request,
      session_id: sessionId,
      ...(identityLinkFlow !== undefined ? { identity_link_flow: identityLinkFlow } : {}),
    });
    if (!("res" in sent)) return { status: "failed", error: `/invoke unreachable: ${errorText(sent.networkError)}` };
    const res = sent.res;
    if (!res.ok) return { status: "failed", error: `/invoke rejected the request: ${res.status} ${await res.text()}` };
    const accepted = (await res.json()) as { id: string };
    return this.poll(accepted.id, hooks);
  }

  /** Polls `GET /invoke/:id` until the turn is terminal, the budget runs out, or the orchestrator stays unreachable. Never throws for a transport failure. */
  async poll(id: string, hooks: PollHooks = {}): Promise<OrchestratorInvokeResult> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    let announcedRunning = false;
    let announcedRemoteControlUrl = false;
    let pollNetworkError: unknown;
    let consecutivePollNetworkErrors = 0;
    while (Date.now() < deadline) {
      await this.sleep(this.options.pollIntervalMs);
      // The SAME failure postInvoke's retry exists for, on the other half of
      // the same conversation. It does not need the orchestrator to be down for
      // seconds: the pod exits about a second after SIGTERM, while kube-proxy
      // applies endpoint changes at most once a second, and a poll sent into
      // that gap reaches an address with nothing behind it (measured as a 10.5s
      // UND_ERR_CONNECT_TIMEOUT; rolling the orchestrator under a gateway-shaped
      // poller lost a poll in 5 of 10 rollouts). Retried instead, the next poll
      // lands on the new pod, which does not know this id and answers 404, and
      // the turn ends as a reported failure rather than as silence.
      let pollRes: Response;
      try {
        pollRes = await this.fetchImpl(`${this.baseUrl()}/invoke/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${await this.resolveToken()}` },
        });
        pollNetworkError = undefined;
        consecutivePollNetworkErrors = 0;
      } catch (err) {
        // Bounded to a few CONSECUTIVE failures, deliberately not to this
        // loop's deadline: the gateway holds a relay open the whole time, and
        // retrying to the deadline on a turn whose orchestrator had gone pinned
        // it for the full poll window, starving the NEXT trigger (see the
        // pollTimeoutMs/resumeWaitMs notes in values-e2e.yaml).
        pollNetworkError = err;
        consecutivePollNetworkErrors++;
        if (consecutivePollNetworkErrors > POLL_NETWORK_RETRY_LIMIT) break;
        continue;
      }
      if (!pollRes.ok) {
        return { status: "failed", error: `/invoke/${id} poll failed: ${pollRes.status}` };
      }
      const polled = (await pollRes.json()) as InvokePollBody;
      // Fire at most once, independent of terminal/pending status below --
      // the underlying agent can surface this mid-run, on the same poll that
      // turns out to already be terminal.
      if (!announcedRemoteControlUrl && polled.remoteControlUrl) {
        announcedRemoteControlUrl = true;
        await hooks.onRemoteControlUrl?.(polled.remoteControlUrl);
      }
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
      // status === "pending". Announce "running" the first time the turn is
      // past its auth pre-flight (not identity-link-pending).
      if (!announcedRunning && !polled.identityLinkPending) {
        announcedRunning = true;
        await hooks.onRunning?.();
      }
    }
    // Distinguished from an ordinary budget expiry: "we never reached it" and
    // "it never finished" have different fixes, and the comment the caller
    // posts is the only place anyone sees either.
    if (pollNetworkError !== undefined) {
      return {
        status: "failed",
        error: `/invoke/${id} unreachable after ${POLL_NETWORK_RETRY_LIMIT} consecutive poll failures: ${errorText(pollNetworkError)}`,
      };
    }
    return { status: "timed_out", error: `no terminal result within ${this.options.pollTimeoutMs}ms` };
  }
}
