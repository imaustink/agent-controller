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
