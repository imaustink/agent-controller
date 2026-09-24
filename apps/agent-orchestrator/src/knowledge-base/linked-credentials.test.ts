import { describe, expect, it, vi } from "vitest";
import { LinkedCredentials } from "./linked-credentials.js";
import type { IdentityLinkPort } from "../identity-link/gateway-client.js";

function links(overrides: Partial<IdentityLinkPort> = {}): IdentityLinkPort {
  return {
    start: vi.fn(),
    poll: vi.fn(),
    getToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IdentityLinkPort;
}

describe("delegatedToken", () => {
  it("returns the caller's own token and provider principal", async () => {
    const resolver = new LinkedCredentials(
      links({
        getToken: vi.fn().mockResolvedValue({ token: "at-1" }),
        getLinkedAccountId: vi.fn().mockResolvedValue("557058:abc"),
      }),
    );

    expect(await resolver.delegatedToken("openwebui:42", ["atlassian"])).toEqual({
      token: "at-1",
      principals: ["user:557058:abc"],
    });
  });

  it("is undefined when nothing is linked", async () => {
    const resolver = new LinkedCredentials(links());
    // The searcher turns this into an ask, which is the honest response.
    expect(await resolver.delegatedToken("s", ["atlassian"])).toBeUndefined();
  });

  it("does NOT report a failed lookup as an absent link", async () => {
    const resolver = new LinkedCredentials(
      links({ getToken: vi.fn().mockRejectedValue(new Error("gateway down")) }),
    );

    // Swallowing this tells a caller to link an account they already linked,
    // on every turn, while the same record works moments later (ADR 0031).
    await expect(resolver.delegatedToken("s", ["atlassian"])).rejects.toThrow(/gateway down/);
  });

  it("tries providers in the order the knowledge base declares", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ token: "slack-token" });
    const resolver = new LinkedCredentials(links({ getToken }));

    const got = await resolver.delegatedToken("s", ["atlassian", "slack"]);

    expect(got?.token).toBe("slack-token");
    expect(getToken.mock.calls.map(([provider]) => provider)).toEqual(["atlassian", "slack"]);
  });

  it("still returns the token when principals cannot be resolved", async () => {
    const resolver = new LinkedCredentials(
      links({
        getToken: vi.fn().mockResolvedValue({ token: "at" }),
        getLinkedAccountId: vi.fn().mockRejectedValue(new Error("identity endpoint down")),
      }),
    );

    // Principals feed a pre-filter that can only save probes. Failing the whole
    // search to protect an optimization would be the wrong trade.
    expect(await resolver.delegatedToken("s", ["atlassian"])).toEqual({
      token: "at",
      principals: undefined,
    });
  });

  it("falls back to a login for GitHub-shaped links", async () => {
    const resolver = new LinkedCredentials(
      links({
        getToken: vi.fn().mockResolvedValue({ token: "gh" }),
        getLinkedAccountId: vi.fn().mockResolvedValue(undefined),
        getLinkedLogin: vi.fn().mockResolvedValue("octocat"),
      }),
    );

    expect((await resolver.delegatedToken("s", ["github"]))?.principals).toEqual(["user:octocat"]);
  });
});

describe("a provider the gateway has not been configured for", () => {
  /** What the deployed gateway actually answers: 400 Unsupported identity provider. */
  const unsupported = () =>
    ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "Unsupported identity provider: atlassian" }),
      json: async () => ({}),
    }) as Response;

  it("falls through instead of failing the whole search", async () => {
    // Found against the real gateway: this fired on the FIRST Atlassian
    // Connection, because the deployed gateway has no atlassian provider. The
    // resolver propagated the 400 and every knowledge-base search touching that
    // connection died, rather than degrading to "link your account".
    const links = {
      start: vi.fn(),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityLinkPort;

    const client = new (await import("../identity-link/gateway-client.js")).IdentityLinkGatewayClient({
      baseUrl: "http://gw",
      token: "t",
      fetchImpl: (async () => unsupported()) as unknown as typeof fetch,
    });

    expect(await client.getToken("atlassian", "s")).toBeUndefined();
    expect(await client.getLinkedAccountId!("atlassian", "s")).toBeUndefined();
    void links;
  });

  it("still raises a genuine failure", async () => {
    const client = new (await import("../identity-link/gateway-client.js")).IdentityLinkGatewayClient({
      baseUrl: "http://gw",
      token: "t",
      fetchImpl: (async () =>
        ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }) as Response) as unknown as typeof fetch,
    });

    // "Could not find out" must stay distinct from "nothing linked" (ADR 0031).
    await expect(client.getToken("github", "s")).rejects.toThrow(/token lookup/);
  });
});
