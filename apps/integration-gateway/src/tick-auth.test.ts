import { describe, expect, it, vi } from "vitest";
import { KubeTokenAuthenticator, TICK_TOKEN_AUDIENCE, tickUsername, type TokenReviewApi } from "./tick-auth.js";

type Status = Awaited<ReturnType<TokenReviewApi["createTokenReview"]>>["status"];

function api(status: Status | (() => never)) {
  return {
    createTokenReview: vi.fn(async () => (typeof status === "function" ? status() : { status })),
  };
}

describe("KubeTokenAuthenticator", () => {
  it("reviews the token for the tick audience and returns the username", async () => {
    const a = api({ authenticated: true, audiences: [TICK_TOKEN_AUDIENCE], user: { username: "system:serviceaccount:ns:eventsource-x" } });
    expect(await new KubeTokenAuthenticator(a).authenticate("t")).toBe("system:serviceaccount:ns:eventsource-x");
    expect(a.createTokenReview).toHaveBeenCalledWith({
      body: { apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", spec: { token: "t", audiences: [TICK_TOKEN_AUDIENCE] } },
    });
  });

  it("refuses an unauthenticated token, one not echoed for our audience, and an API error", async () => {
    const user = { username: "system:serviceaccount:ns:eventsource-x" };
    expect(await new KubeTokenAuthenticator(api({ authenticated: false, audiences: [TICK_TOKEN_AUDIENCE], user })).authenticate("t")).toBeUndefined();
    expect(await new KubeTokenAuthenticator(api({ authenticated: true, user })).authenticate("t")).toBeUndefined();
    expect(await new KubeTokenAuthenticator(api({ authenticated: true, audiences: ["https://kubernetes.default.svc"], user })).authenticate("t")).toBeUndefined();
    const boom = api(() => {
      throw new Error("forbidden");
    });
    expect(await new KubeTokenAuthenticator(boom).authenticate("t")).toBeUndefined();
  });

  it("caches an outcome per token for the TTL, then reviews again", async () => {
    let now = 0;
    const a = api({ authenticated: false });
    const auth = new KubeTokenAuthenticator(a, TICK_TOKEN_AUDIENCE, () => now);
    await auth.authenticate("t");
    await auth.authenticate("t");
    expect(a.createTokenReview).toHaveBeenCalledTimes(1);
    await auth.authenticate("u");
    expect(a.createTokenReview).toHaveBeenCalledTimes(2);
    now = 31_000;
    await auth.authenticate("t");
    expect(a.createTokenReview).toHaveBeenCalledTimes(3);
  });
});

describe("tickUsername", () => {
  it("is the source's eventsource-<name> ServiceAccount", () => {
    expect(tickUsername("agents", "nightly")).toBe("system:serviceaccount:agents:eventsource-nightly");
  });
});
