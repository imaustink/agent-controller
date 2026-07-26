import { describe, expect, it } from "vitest";
import { OpenWebUiForwardedUserResolver } from "../../apps/agent-orchestrator/src/rbac/openwebui-forwarded-user-resolver.js";
import { assembleSseContent, mintForwardedUserJwt } from "../support/openwebui-jwt.js";

/**
 * The chat harness, checked against the product code it has to agree with.
 *
 * Deliberately NO `requireMinikubeContext()`: this spec touches no cluster, so
 * it runs anywhere `npm run e2e` runs. That is the point. A harness's signing is
 * the part most likely to be quietly wrong, and when it is, every cluster spec
 * built on it fails with "could not resolve caller identity" -- which reads as a
 * product defect and costs a full stack cycle to disprove. Verifying the
 * agreement here turns that class of failure into a fast, unambiguous red.
 *
 * It imports the REAL resolver rather than reimplementing its expectations: the
 * claim the harness signs and the claim the orchestrator reads have to be the
 * same claim, and only the resolver itself is authoritative about which that is.
 */
describe("chat harness agrees with the orchestrator's forwarded-user resolver", () => {
  const SECRET = "e2e-openwebui-forward-jwt-secret";
  const resolver = new OpenWebUiForwardedUserResolver({ secret: SECRET, roles: ["reader", "writer"] });

  it("mints a JWT the resolver accepts, resolving the subject the specs assert on", async () => {
    const identity = await resolver.resolve(mintForwardedUserJwt(SECRET, "e2e-chat-user"));

    expect(identity).toEqual({
      subject: "openwebui:e2e-chat-user",
      roles: ["reader", "writer"],
      // The assertion that makes the chat specs meaningful: without `perUser`
      // the pre-flight refuses to establish or adopt anything (docs/adr/0031),
      // so a harness that lost this would silently test the degraded path while
      // appearing to test convergence.
      perUser: true,
    });
  });

  it("is rejected when signed with the wrong secret", async () => {
    // Proves the resolver is actually verifying, so the test above is evidence
    // of agreement rather than of a resolver that accepts anything.
    await expect(resolver.resolve(mintForwardedUserJwt("not-the-deployments-secret", "e2e-chat-user"))).resolves.toBeUndefined();
  });

  it("assembles the assistant's text out of an OpenAI-style stream", async () => {
    const body = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"To continue, please "}}]}',
      ": keep-alive",
      'data: {"choices":[{"delta":{"content":"link your GitHub account"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");

    // Frames with no content delta, comments and the terminator are skipped
    // rather than parsed strictly -- a spec asserting on what the human saw
    // should not fail over a frame shape it doesn't care about.
    expect(assembleSseContent(body)).toBe("To continue, please link your GitHub account");
  });
});
