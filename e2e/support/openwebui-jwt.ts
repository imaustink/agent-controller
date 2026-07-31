import { createHmac } from "node:crypto";

/**
 * The parts of the chat harness that touch nothing outside this file.
 *
 * Split from `chat.ts` (which shells out to kubectl and port-forwards) so they
 * can be verified WITHOUT a cluster -- see specs/chat-harness.e2e.ts. Signing is
 * the part of a harness most likely to be quietly wrong: a malformed JWT makes
 * identity resolution fail closed, and every spec built on it then fails looking
 * like a product bug.
 */

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/**
 * Mints the HS256 JWT Open WebUI would send for a signed-in user.
 *
 * Hand-rolled rather than pulling in `jose`: the payload is one claim, the
 * algorithm is fixed on both sides, and `e2e/` has deliberately kept its
 * dependency list to vitest + typescript. Same no-new-dependency precedent as
 * the orchestrator's own `sender-assertion.ts`.
 */
export function mintForwardedUserJwt(secret: string, userId: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  // `id` is the claim the resolver prefers; `role` is Open WebUI's own
  // vocabulary and is deliberately ignored by the resolver (this system's RBAC
  // roles come from configuration, not from the header).
  const payload = b64url(JSON.stringify({ id: userId, role: "user" }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Concatenates the `content` deltas out of an OpenAI-style SSE stream.
 *
 * Tolerant by design: `[DONE]`, keep-alives and any chunk without a content
 * delta are skipped rather than parsed strictly. A test asserting on what the
 * human saw should not fail over a frame shape it doesn't care about.
 */
export function assembleSseContent(body: string): string {
  let text = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      // Not a JSON frame -- nothing to assemble from it.
    }
  }
  return text;
}

/** One tool call the agent asked the CALLER to execute, as a client would read it off the stream. */
export interface StreamedToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, per OpenAI's wire format (a string, not an object). */
  arguments: string;
}

/**
 * Collects `tool_calls` deltas out of an OpenAI-style SSE stream
 * (docs/adr/0035).
 *
 * Assembled by `index` rather than by arrival order, and arguments are
 * CONCATENATED, because that is the contract a real OpenAI client implements: the
 * wire format permits a call's arguments to arrive across several deltas. This
 * orchestrator happens to emit each call whole (its planner produces the
 * arguments in one shot, so there is nothing to stream incrementally) — but a
 * harness that assumed that would stop detecting the difference, and the whole
 * point of asserting on the stream is to check what a real client would be able
 * to reconstruct.
 */
export function assembleSseToolCalls(body: string): StreamedToolCall[] {
  const byIndex = new Map<number, StreamedToolCall>();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: {
      choices?: { delta?: { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      continue;
    }
    for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = byIndex.get(index) ?? { id: "", name: "", arguments: "" };
      byIndex.set(index, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        arguments: existing.arguments + (call.function?.arguments ?? ""),
      });
    }
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
}

/**
 * The stream's terminal `finish_reason`.
 *
 * The single most load-bearing field for caller tools: `"tool_calls"` is what
 * tells a client to EXECUTE something, and `"stop"` is what tells it to render an
 * answer. A turn that produced tool calls but finished with `"stop"` would leave
 * every real client showing an empty assistant message — indistinguishable, from
 * the content alone, from a turn that simply had nothing to say.
 */
export function sseFinishReason(body: string): string | undefined {
  let reason: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data) as { choices?: { finish_reason?: string | null }[] };
      const value = chunk.choices?.[0]?.finish_reason;
      if (typeof value === "string") reason = value;
    } catch {
      // Not a JSON frame.
    }
  }
  return reason;
}
