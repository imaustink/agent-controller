import { describe, expect, it, vi } from "vitest";
import { canonicalSubjectForLogin, resolveCredentialSubject } from "./credential-subject.js";

function githubGateway(githubLogin?: string) {
  return { getToken: vi.fn().mockResolvedValue(githubLogin ? { token: "gh", githubLogin } : undefined) };
}

describe("canonicalSubjectForLogin", () => {
  it("namespaces and lower-cases the login", () => {
    expect(canonicalSubjectForLogin("Imaustink")).toBe("github:imaustink");
    expect(canonicalSubjectForLogin("imaustink")).toBe("github:imaustink");
  });
});

describe("resolveCredentialSubject", () => {
  it("leaves non-Claude providers on the raw subject", async () => {
    const gw = githubGateway("imaustink");
    // `github` is the source of the mapping, so canonicalizing it would be
    // circular -- and triage's GitHub writes must stay on their own subject.
    expect(await resolveCredentialSubject("github", "openwebui:42", "imaustink", gw)).toBe("openwebui:42");
    expect(gw.getToken).not.toHaveBeenCalled();
  });

  it.each(["claude", "claude-remote"])("canonicalizes %s from senderLogin without any lookup", async (provider) => {
    const gw = githubGateway("someone-else");
    expect(await resolveCredentialSubject(provider, "service-subject", "Imaustink", gw)).toBe("github:imaustink");
    // senderLogin is authoritative for a webhook turn: consulting the link
    // would let the shared service account's link win over the real human.
    expect(gw.getToken).not.toHaveBeenCalled();
  });

  it("canonicalizes from the caller's GitHub link when there is no senderLogin", async () => {
    const gw = githubGateway("Imaustink");
    expect(await resolveCredentialSubject("claude", "openwebui:42", undefined, gw)).toBe("github:imaustink");
    expect(gw.getToken).toHaveBeenCalledWith("github", "openwebui:42");
  });

  it("produces the SAME subject for a chat turn and a triage turn by the same human", async () => {
    const chat = await resolveCredentialSubject("claude-remote", "openwebui:42", undefined, githubGateway("imaustink"));
    const triage = await resolveCredentialSubject("claude-remote", "service-subject", "Imaustink", githubGateway());
    // The entire point of the change.
    expect(chat).toBe(triage);
  });

  it("falls back to the raw subject when nothing resolves a login", async () => {
    expect(await resolveCredentialSubject("claude", "openwebui:42", undefined, githubGateway())).toBe("openwebui:42");
  });

  it("falls back to the raw subject when no github gateway is configured", async () => {
    expect(await resolveCredentialSubject("claude", "openwebui:42", undefined, undefined)).toBe("openwebui:42");
  });

  it("falls back to the raw subject when the lookup throws", async () => {
    const gw = { getToken: vi.fn().mockRejectedValue(new Error("gateway down")) };
    await expect(resolveCredentialSubject("claude", "openwebui:42", undefined, gw)).resolves.toBe("openwebui:42");
  });

  it("ignores a link that carries no githubLogin", async () => {
    const gw = { getToken: vi.fn().mockResolvedValue({ token: "gh" }) };
    expect(await resolveCredentialSubject("claude", "openwebui:42", undefined, gw)).toBe("openwebui:42");
  });
});
