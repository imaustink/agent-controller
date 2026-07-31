import { fetchThrough, waitFor, withPortForward } from "./k8s.js";

/**
 * The PROGRAMMATIC entry point (`POST /invoke` + `GET /invoke/:id`, ADR 0006).
 *
 * Separate from `chat.ts` on purpose: this suite's standing rule is that when a
 * behaviour differs per entry point, it gets covered from each, because every
 * keying bug in this repo's history has been an asymmetry between two of them
 * (see e2e/README.md).
 *
 * Caller-supplied tools (ADR 0035) are exactly such a behaviour. Both entry
 * points may OFFER tools, but only the chat facade can resume from their results:
 * `/invoke` takes a single `request` string with nowhere to put a `role: "tool"`
 * message. That asymmetry is documented as a deliberate limit, and a documented
 * limit is worth an assertion — otherwise "offering works here too" is a claim
 * nothing checks.
 *
 * Unlike a webhook-relayed turn this carries no `senderLogin`, so it resolves to
 * the shared `client-integration-gateway` subject from values-e2e.yaml's
 * `staticIdentities`. Fine for caller tools, which involve no per-user identity
 * at all — the caller runs their own function under their own credentials.
 */

const ORCHESTRATOR_SERVICE = "agent-orchestrator-invoke";
const ORCHESTRATOR_PORT = 8081;
const LOCAL_PORT = 18097;

/** Matches values-e2e.yaml's `staticIdentities` entry — the token /invoke callers authenticate with. */
const BEARER = "e2e-gateway-token";

/** The polled `GET /invoke/:id` record, narrowed to what a spec asserts on. */
export interface InvocationRecord {
  id: string;
  status: "pending" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
  /** Tool calls the turn wants the CALLER to execute (ADR 0035). */
  pendingToolCalls?: { id: string; name: string; arguments: string }[];
}

/**
 * Posts one `/invoke` turn and polls until it settles.
 *
 * Accept-then-poll rather than blocking, because that IS the contract (ADR 0006):
 * the response is a `202` with an id, and a helper that hid the poll would be
 * testing a shape this API does not have.
 */
export async function invokeTurn(
  request: string,
  opts: { tools?: unknown[]; toolChoice?: unknown; sessionId?: string; timeoutMs?: number } = {},
): Promise<InvocationRecord> {
  return withPortForward(ORCHESTRATOR_SERVICE, ORCHESTRATOR_PORT, LOCAL_PORT, async (_baseUrl, forward) => {
    const res = await fetchThrough(forward, "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
      body: JSON.stringify({
        request,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
      }),
    });
    // A rejected body never becomes an invocation, so surface the status rather
    // than polling an id that was never issued.
    if (res.status !== 202) {
      throw new Error(`e2e: /invoke returned ${res.status}: ${await res.text()}`);
    }
    const { id } = (await res.json()) as { id: string };

    return waitFor(
      `/invoke/${id} to reach a terminal status`,
      async () => {
        const poll = await fetchThrough(forward, `/invoke/${id}`);
        if (!poll.ok) return undefined;
        const record = (await poll.json()) as InvocationRecord;
        return record.status === "pending" ? undefined : record;
      },
      { timeoutMs: opts.timeoutMs ?? 180_000, intervalMs: 2_000 },
    );
  });
}

/** The raw HTTP status of a `POST /invoke`, for asserting that a bad body is REJECTED. */
export async function invokeStatus(body: unknown): Promise<number> {
  return withPortForward(ORCHESTRATOR_SERVICE, ORCHESTRATOR_PORT, LOCAL_PORT, async (_baseUrl, forward) => {
    const res = await fetchThrough(forward, "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
      body: JSON.stringify(body),
    });
    return res.status;
  });
}
