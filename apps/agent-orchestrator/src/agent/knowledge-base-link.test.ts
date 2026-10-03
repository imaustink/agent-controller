import { describe, expect, it, vi } from "vitest";
import { enrichKnowledgeBaseResult, knowledgeBaseLinkPrompt } from "./graph.js";
import type { IdentityLinkPort } from "../identity-link/gateway-client.js";

const BASE = "I need you to link the account behind Sierra Nevada Corporation (atlassian, google) before I can search it.";

function gatewayStarting(impl?: IdentityLinkPort["start"]): IdentityLinkPort {
  return {
    start:
      impl ??
      vi.fn(async (provider: string) => ({
        flow: "authcode" as const,
        authorizeUrl: `https://gw.example/link/${provider}`,
        expiresInSeconds: 600,
      })),
    poll: vi.fn(),
    getToken: vi.fn(),
  } as unknown as IdentityLinkPort;
}

describe("knowledgeBaseLinkPrompt", () => {
  it("starts an authcode flow per provider and appends a clickable link for each", async () => {
    const identityLinkGateway = gatewayStarting();

    const out = await knowledgeBaseLinkPrompt(
      { identityLinkGateway } as never,
      "openwebui:42",
      ["atlassian", "google"],
      BASE,
    );

    // Each provider's flow is started AS the caller.
    expect(identityLinkGateway.start).toHaveBeenCalledWith("atlassian", "openwebui:42", "authcode");
    expect(identityLinkGateway.start).toHaveBeenCalledWith("google", "openwebui:42", "authcode");
    // The dead-end message becomes a clickable link per provider.
    expect(out).toContain(BASE);
    expect(out).toContain("[link your atlassian account](https://gw.example/link/atlassian)");
    expect(out).toContain("[link your google account](https://gw.example/link/google)");
    expect(out).toContain("ask again");
  });

  it("skips a provider whose flow could not be started, keeping the others", async () => {
    const start = vi.fn(async (provider: string) => {
      if (provider === "atlassian") throw new Error("gateway refused");
      return { flow: "authcode" as const, authorizeUrl: `https://gw.example/link/${provider}`, expiresInSeconds: 600 };
    });
    const identityLinkGateway = gatewayStarting(start as unknown as IdentityLinkPort["start"]);

    const out = await knowledgeBaseLinkPrompt(
      { identityLinkGateway } as never,
      "openwebui:42",
      ["atlassian", "google"],
      BASE,
    );

    expect(out).not.toContain("link/atlassian");
    expect(out).toContain("[link your google account](https://gw.example/link/google)");
  });

  it("falls back to the plain ask when no provider can be started", async () => {
    // No identity-link gateway configured -> nothing to start -> unchanged message
    // (a misconfiguration degrades, it does not swallow the turn).
    const out = await knowledgeBaseLinkPrompt({} as never, "openwebui:42", ["atlassian"], BASE);
    expect(out).toBe(BASE);
  });
});

describe("enrichKnowledgeBaseResult", () => {
  it("appends a link on a PARTIAL answer (linkProviders set, needsLink absent)", async () => {
    // This is the exact wiring #271 adds: a partial answer carries linkProviders
    // without needsLink, and must still get a clickable link. Re-adding a
    // `needsLink &&` guard to the dispatch branches would fail this test.
    const identityLinkGateway = gatewayStarting();

    const out = await enrichKnowledgeBaseResult({ identityLinkGateway } as never, "openwebui:42", {
      result: "Found 2 passage(s). …Drive + Confluence answer…",
      linkProviders: ["google"],
    });

    expect(out).toContain("Found 2 passage(s)");
    expect(out).toContain("[link your google account](https://gw.example/link/google)");
    expect(identityLinkGateway.start).toHaveBeenCalledWith("google", "openwebui:42", "authcode");
  });

  it("returns the result unchanged when there are no providers to link", async () => {
    const identityLinkGateway = gatewayStarting();

    const out = await enrichKnowledgeBaseResult({ identityLinkGateway } as never, "openwebui:42", {
      result: "A complete answer with every provider linked.",
      linkProviders: [],
    });

    expect(out).toBe("A complete answer with every provider linked.");
    expect(identityLinkGateway.start).not.toHaveBeenCalled();
  });
});

describe("knowledgeBaseLinkPrompt with a Connections page", () => {
  it("offers ONE link to the page naming every missing provider", async () => {
    const identityLinkGateway = gatewayStarting();
    const out = await knowledgeBaseLinkPrompt(
      { identityLinkGateway, connectionsUrl: "https://gw.example/connections" } as never,
      "openwebui:42",
      ["atlassian", "google"],
      BASE,
    );

    expect(out).toContain(BASE);
    expect(out).toContain("[Connect atlassian and google](https://gw.example/connections?need=atlassian%2Cgoogle)");
    expect(identityLinkGateway.start).not.toHaveBeenCalled();
  });

  it("keeps per-provider direct links for a subject the page cannot map", async () => {
    const identityLinkGateway = gatewayStarting();
    const out = await knowledgeBaseLinkPrompt(
      { identityLinkGateway, connectionsUrl: "https://gw.example/connections" } as never,
      "integration-gateway",
      ["google"],
      BASE,
    );
    expect(out).toContain("[link your google account](https://gw.example/link/google)");
  });
});
