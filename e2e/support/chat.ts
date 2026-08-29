import { kubectl, withPortForward } from "./k8s.js";
import {
  assembleSseContent,
  assembleSseToolCalls,
  mintForwardedUserJwt,
  sseFinishReason,
  type StreamedToolCall,
} from "./openwebui-jwt.js";

// Re-exported so a spec has one import for "the chat entry point", while the
// cluster-free helpers stay independently testable (specs/chat-harness.e2e.ts).
export {
  assembleSseContent,
  assembleSseToolCalls,
  mintForwardedUserJwt,
  sseFinishReason,
  type StreamedToolCall,
} from "./openwebui-jwt.js";

/**
 * The CHAT entry point, as a test can drive it.
 *
 * Everything else in `e2e/` drives the webhook path, which is why the one-way
 * credential convergence of docs/adr/0031 survived a suite built specifically
 * to catch keying bugs: with no way to make a per-user chat call, the flow that
 * could not resolve a principal was never exercised. This module is that way.
 *
 * Two things make a chat turn different from a relayed webhook, and both matter
 * to the identity it resolves:
 *
 * - **Identity comes from a per-request signed JWT**, not the bearer token. Open
 *   WebUI's `Authorization` value is one static string shared by every one of
 *   its users, so the orchestrator resolves the caller from the
 *   `X-OpenWebUI-User-Jwt` header instead (`OpenWebUiForwardedUserResolver`),
 *   which is what makes the subject per-user and, since ADR 0031, what lets a
 *   principal be established against it.
 * - **It is an OpenAI-shaped `/v1/chat/completions` call**, streaming, so the
 *   turn holds a live channel the way the real chat surface does.
 */

const ORCHESTRATOR_SERVICE = "agent-orchestrator-invoke";
const ORCHESTRATOR_PORT = 8081;
const CHAT_PORT = 18095;
const FORWARDED_USER_JWT_HEADER = "x-openwebui-user-jwt";

/**
 * Open WebUI's forwarded-user JWT secret, read from the cluster for the same
 * reason `webhookSecret()` is: the test has to sign with whatever the
 * deployment verifies against, or identity resolution fails closed and the turn
 * 401s in a way that looks like a product bug.
 */
async function forwardedUserJwtSecret(): Promise<string> {
  const b64 = (
    await kubectl(["get", "secret", "e2e-openwebui-forward-jwt", "-o", "jsonpath={.data.AGENT_OPENWEBUI_USER_JWT_SECRET}"])
  ).trim();
  if (!b64) {
    throw new Error(
      "e2e: AGENT_OPENWEBUI_USER_JWT_SECRET not found on e2e-openwebui-forward-jwt (run e2e/scripts/bootstrap-secrets.sh)",
    );
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

/** The subject `OpenWebUiForwardedUserResolver` resolves for a given Open WebUI user id. */
export function chatSubject(userId: string): string {
  return `openwebui:${userId}`;
}

/**
 * Sends one streaming chat turn as `userId` and returns the assembled assistant
 * text.
 *
 * Streaming (`stream: true`) on purpose: it is the shape the real Open WebUI
 * surface uses, and the only one that gives the turn a live progress channel --
 * so a link prompt surfaces mid-turn exactly as a human would see it, rather
 * than only in the final message.
 *
 * The `sessionId` is a real chat id, defaulted per call rather than fixed: it
 * keys session state (active agent run, pending identity link), and a shared
 * constant would let one spec's parked link resume inside another's turn.
 *
 * Returns whatever the caller SAW plus whether the turn parked, rather than one
 * or the other. Both matter, and a parked turn is not an empty one:
 *
 * - A turn that needs an account link and has a live channel deliberately holds
 *   open for the whole flow expiry waiting for the human, so `parked` is the
 *   product working, not a failure -- but only when `allowPark` says the caller
 *   expects it. Otherwise the timeout rethrows, so a genuine hang still fails
 *   loudly instead of reading as "no reply".
 * - The link prompt itself is streamed as real chat CONTENT (server.ts streams
 *   the `identity-link` stage as a content delta, not a status label), so `text`
 *   is what makes "was the user asked to link?" assertable at all. Reading the
 *   body only after completion threw that away for exactly the turns that carry
 *   the prompt, so the stream is consumed incrementally instead.
 */
export interface ChatTurnResult {
  /** The assistant text the caller saw, assembled from the stream -- including anything streamed before a park. */
  text: string;
  /** True when the turn was still open when the client's deadline elapsed (see `allowPark`). */
  parked: boolean;
}

export async function chatTurn(
  userId: string,
  request: string,
  opts: { sessionId?: string; timeoutMs?: number; allowPark?: boolean } = {},
): Promise<ChatTurnResult> {
  const { raw, parked } = await streamChat(userId, [{ role: "user", content: request }], opts);
  return { text: assembleSseContent(raw), parked };
}

/** An OpenAI `tools[]` entry, as a consumer would send it (docs/adr/0035). */
export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

/** A message in the conversation a caller sends, including the tool round trip's own shapes. */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  /** Set on the assistant message that asked the client to run a tool. */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** Set on a `role: "tool"` message, echoing the call it answers. */
  tool_call_id?: string;
}

export interface ChatToolTurnResult extends ChatTurnResult {
  /** Tool calls the agent asked THIS CLIENT to execute, assembled off the stream. */
  toolCalls: StreamedToolCall[];
  /** `"tool_calls"` when the turn wants the client to run something, `"stop"` when it answered. */
  finishReason: string | undefined;
}

/**
 * Sends a turn carrying the caller's OWN tools, and reports what a real OpenAI
 * client would be able to act on (docs/adr/0035).
 *
 * Takes a full `messages` array rather than one request string, because the
 * caller-tool round trip is inherently multi-message: the client resumes by
 * resending the conversation with the `assistant.tool_calls` it was given plus a
 * `role: "tool"` result. There is no server-side conversation store to resume
 * from instead, so the wire IS the state, and a harness that could only send one
 * user message could never exercise the second half of the feature.
 *
 * Streaming, like `chatTurn` and for the same reason: it is the shape Open WebUI
 * actually uses. It also carries the more fragile half of the contract — a
 * blocking response can set `finish_reason` after the fact, whereas the streaming
 * path has already flushed its headers and has to get the terminal frame right.
 */
export async function chatToolTurn(
  userId: string,
  messages: ChatMessage[],
  opts: {
    tools?: ChatToolDefinition[];
    toolChoice?: unknown;
    sessionId?: string;
    timeoutMs?: number;
    allowPark?: boolean;
  } = {},
): Promise<ChatToolTurnResult> {
  const { raw, parked } = await streamChat(userId, messages, opts, {
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
  });
  return {
    text: assembleSseContent(raw),
    parked,
    toolCalls: assembleSseToolCalls(raw),
    finishReason: sseFinishReason(raw),
  };
}

/**
 * The shared streaming core: mints the per-user JWT, posts the completion, and
 * returns the RAW SSE body.
 *
 * Raw rather than pre-assembled so each caller decides what it needs off the same
 * stream (`chatTurn` wants content, `chatToolTurn` wants content AND tool calls
 * AND the finish reason) without the fetch/abort/park handling — all of it
 * learned the hard way, see below — being duplicated per shape.
 */
async function streamChat(
  userId: string,
  messages: ChatMessage[],
  opts: { sessionId?: string; timeoutMs?: number; allowPark?: boolean },
  extraBody: Record<string, unknown> = {},
): Promise<{ raw: string; parked: boolean }> {
  const secret = await forwardedUserJwtSecret();
  const jwt = mintForwardedUserJwt(secret, userId);
  const sessionId = opts.sessionId ?? `e2e-chat-${userId}-${process.pid}`;

  return withPortForward(ORCHESTRATOR_SERVICE, ORCHESTRATOR_PORT, CHAT_PORT, async (baseUrl) => {
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The shared Open WebUI bearer. Identity does NOT come from this -- the
          // JWT header below is what makes the caller per-user -- but the request
          // still has to authenticate, and this is the value values-e2e.yaml's
          // staticIdentities map registers.
          authorization: "Bearer e2e-gateway-token",
          // Must match `CHAT_ID_HEADER` in agent-orchestrator's server.ts
          // exactly ("x-chat-id" is not a header either engine reads): get
          // this wrong and every turn silently falls back to a random
          // ephemeral session, so two calls "in the same conversation" each
          // land in their own workflow with no shared state whatsoever.
          "x-openwebui-chat-id": sessionId,
          [FORWARDED_USER_JWT_HEADER]: jwt,
        },
        body: JSON.stringify({ model: "agent-orchestrator", stream: true, messages, ...extraBody }),
        // A chat turn that needs a link holds its connection open for the whole
        // flow expiry, and a delegated turn waits on a real agent run. Generous,
        // but bounded: an unbounded fetch turns a hung turn into a hung suite.
        signal: AbortSignal.timeout(opts.timeoutMs ?? 420_000),
      });
      if (!res.ok) {
        throw new Error(`e2e: chat completion failed: ${res.status} ${await res.text()}`);
      }
      // Read INCREMENTALLY, keeping every chunk. Two reasons, both learned the
      // hard way: the abort fires here rather than on `fetch` (the orchestrator
      // flushes SSE headers immediately, so `fetch` resolves as soon as they
      // land), and `res.text()` discards the partial body on abort -- which is
      // precisely the body of a turn that streamed a link prompt and then waited.
      const reader = res.body?.getReader();
      if (!reader) return { raw: "", parked: false };
      const decoder = new TextDecoder();
      let raw = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      } catch (err) {
        if (opts.allowPark && isAbort(err)) return { raw, parked: true };
        throw err;
      }
      return { raw, parked: false };
    } catch (err) {
      // Distinguish "the turn parked" from every other failure. Only a caller
      // that expects a park may swallow it; anything else is a real fault and
      // must surface, including a genuine hang.
      //
      // Checked by NAME rather than `instanceof Error`: `AbortSignal.timeout`
      // rejects with a DOMException, and undici may surface it wrapped, so the
      // reason can sit on `cause`.
      if (opts.allowPark && isAbort(err)) return { raw: "", parked: true };
      throw err;
    }
  });
}

/** Whether a rejection is an abort/timeout, however undici chose to wrap it. */
function isAbort(err: unknown): boolean {
  const names = [(err as { name?: string } | undefined)?.name, (err as { cause?: { name?: string } } | undefined)?.cause?.name];
  return names.some((name) => name === "TimeoutError" || name === "AbortError");
}
