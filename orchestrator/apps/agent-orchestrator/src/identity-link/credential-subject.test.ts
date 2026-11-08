import { describe, expect, it, vi } from "vitest";
import { canonicalSubjectForLogin, isCanonicalPrincipal, resolveActorLogin, resolvePrincipal } from "./credential-subject.js";

function githubGateway(githubLogin?: string) {
  return { getToken: vi.fn().mockResolvedValue(githubLogin ? { token: "gh", githubLogin } : undefined) };
}

describe("canonicalSubjectForLogin", () => {
  it("namespaces and lower-cases the login", () => {
    expect(canonicalSubjectForLogin("Imaustink")).toBe("github:imaustink");
    expect(canonicalSubjectForLogin("imaustink")).toBe("github:imaustink");
  });
});

describe("resolvePrincipal", () => {
  it("uses senderLogin without any lookup -- the webhook sender is authoritative", async () => {
    const gw = githubGateway("someone-else");
    expect(await resolvePrincipal("service-subject", "Imaustink", gw)).toBe("github:imaustink");
    // Consulting the link would let the shared service account's own link win
    // over the actual human who triggered the event.
    expect(gw.getToken).not.toHaveBeenCalled();
  });

  it("falls back to the caller's GitHub link when there is no senderLogin", async () => {
    const gw = githubGateway("Imaustink");
    expect(await resolvePrincipal("openwebui:42", undefined, gw)).toBe("github:imaustink");
    expect(gw.getToken).toHaveBeenCalledWith("github", "openwebui:42");
  });

  it("gives a chat turn and a webhook turn by the same human ONE principal", async () => {
    const chat = await resolvePrincipal("openwebui:42", undefined, githubGateway("imaustink"));
    const webhook = await resolvePrincipal("client-integration-gateway", "Imaustink", githubGateway());
    // The entire point: one authorization covers both entry points.
    expect(chat).toBe(webhook);
  });

  it("does not collapse two different humans onto one principal", async () => {
    const a = await resolvePrincipal("openwebui:1", undefined, githubGateway("alice"));
    const b = await resolvePrincipal("openwebui:2", undefined, githubGateway("bob"));
    expect(a).not.toBe(b);
  });

  it("uses the raw subject as its own principal when no GitHub identity resolves", async () => {
    // A working state, not a failure -- no cross-entry-point sharing, which is
    // exactly the behaviour before principals existed.
    expect(await resolvePrincipal("openwebui:42", undefined, githubGateway())).toBe("openwebui:42");
    expect(await resolvePrincipal("openwebui:42", undefined, undefined)).toBe("openwebui:42");
  });

  it("falls back to the raw subject when the lookup throws", async () => {
    const gw = { getToken: vi.fn().mockRejectedValue(new Error("gateway down")) };
    await expect(resolvePrincipal("openwebui:42", undefined, gw)).resolves.toBe("openwebui:42");
  });
});

describe("resolveActorLogin", () => {
  it("prefers senderLogin, then the link, then nothing", async () => {
    expect(await resolveActorLogin("s", "sender", githubGateway("linked"))).toBe("sender");
    expect(await resolveActorLogin("s", undefined, githubGateway("linked"))).toBe("linked");
    expect(await resolveActorLogin("s", undefined, githubGateway())).toBeUndefined();
  });

  it("is independent of any Agent's identityProviders (docs/adr/0030)", async () => {
    // Knowing WHO the caller is and provisioning them a credential are
    // different concerns; conflating them is what caused the production 401.
    expect(await resolveActorLogin("openwebui:42", undefined, githubGateway("imaustink"))).toBe("imaustink");
  });
});

describe("isCanonicalPrincipal", () => {
  it("tells a canonical principal apart from a raw entry-point subject", async () => {
    // What the authorization pre-flight branches on: only the second shape can
    // be shared across entry points, so only the first needs establishing.
    expect(isCanonicalPrincipal("github:imaustink")).toBe(true);
    expect(isCanonicalPrincipal("openwebui:42")).toBe(false);
    expect(isCanonicalPrincipal("client-integration-gateway")).toBe(false);
    // The fallback resolvePrincipal returns is, by construction, not canonical.
    expect(isCanonicalPrincipal(await resolvePrincipal("openwebui:42", undefined, undefined))).toBe(false);
  });
});
