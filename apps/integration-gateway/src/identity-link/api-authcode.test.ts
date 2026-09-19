import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityLinkApi } from "./api.js";
import type { GithubDeviceFlowLinker } from "./device-flow-linker.js";
import type { OAuthAuthCodeLinker } from "./oauth-authcode-linker.js";

/**
 * Routing for authorization-code providers alongside GitHub's device flow.
 *
 * GitHub's own behaviour is covered by `api.test.ts` and must not change; what
 * these assert is that a second provider reaches its own linker, and that
 * device-flow-shaped requests against it are refused rather than quietly
 * reinterpreted.
 */
const TOKEN = "test-identity-link-token";

const nativeFetch = globalThis.fetch;
const fetch: typeof globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return nativeFetch(input, { ...init, headers });
};

describe("IdentityLinkApi with an authcode provider", () => {
  let server: Server;
  let base: string;
  let atlassian: {
    startAuthCode: ReturnType<typeof vi.fn>;
    completeAuthCode: ReturnType<typeof vi.fn>;
    getValidToken: ReturnType<typeof vi.fn>;
    getLinkedAccountId: ReturnType<typeof vi.fn>;
    waitForCompletion: ReturnType<typeof vi.fn>;
  };
  let github: { startAuthCode: ReturnType<typeof vi.fn>; getValidToken: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    atlassian = {
      startAuthCode: vi.fn().mockReturnValue({ authorizeUrl: "https://auth.atlassian.com/authorize?x=1", expiresInSeconds: 600 }),
      completeAuthCode: vi.fn().mockResolvedValue({ subject: "openwebui:42" }),
      getValidToken: vi.fn().mockResolvedValue({ token: "atl-token" }),
      getLinkedAccountId: vi.fn().mockResolvedValue("acc-123"),
      waitForCompletion: vi.fn().mockResolvedValue({ token: "atl-token" }),
    };
    github = {
      startAuthCode: vi.fn().mockResolvedValue({ flow: "authcode", authorizeUrl: "https://github.test" }),
      getValidToken: vi.fn().mockResolvedValue({ token: "gh-token", githubLogin: "octocat" }),
    };

    const api = new IdentityLinkApi(
      github as unknown as GithubDeviceFlowLinker,
      TOKEN,
      new Map([["atlassian", atlassian as unknown as OAuthAuthCodeLinker]]),
    );

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://gw.invalid");
      void api
        .handleCallback(req, res, url)
        .then((handled) => (handled ? true : api.handle(req, res, url)))
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => server.close());

  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
    });

  it("still rejects a provider nobody configured", async () => {
    const res = await authed("/identity-link/notion/start", {
      method: "POST",
      body: JSON.stringify({ subject: "s" }),
    });
    expect(res.status).toBe(400);
  });

  it("starts an authcode link through the provider's own linker", async () => {
    const res = await authed("/identity-link/atlassian/start", {
      method: "POST",
      body: JSON.stringify({ subject: "openwebui:42" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authorizeUrl: expect.stringContaining("atlassian.com") });
    expect(atlassian.startAuthCode).toHaveBeenCalledWith("openwebui:42");
    // GitHub's linker must not be consulted for another provider.
    expect(github.startAuthCode).not.toHaveBeenCalled();
  });

  it("refuses an explicit device-flow request rather than reinterpreting it", async () => {
    const res = await authed("/identity-link/atlassian/start", {
      method: "POST",
      body: JSON.stringify({ subject: "s", flow: "device" }),
    });

    expect(res.status).toBe(400);
    expect(atlassian.startAuthCode).not.toHaveBeenCalled();
  });

  it("refuses poll, which is the device flow's mechanism", async () => {
    const res = await authed("/identity-link/atlassian/poll", {
      method: "POST",
      body: JSON.stringify({ subject: "s", deviceCode: "dc" }),
    });
    expect(res.status).toBe(400);
  });

  it("serves a token from the provider's linker", async () => {
    const res = await authed("/identity-link/atlassian/token?subject=openwebui:42");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "atl-token" });
    expect(github.getValidToken).not.toHaveBeenCalled();
  });

  it("answers identity with an account id, since there is no login", async () => {
    const res = await authed("/identity-link/atlassian/identity?subject=openwebui:42");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "acc-123" });
  });

  it("404s identity for a subject that linked nothing", async () => {
    atlassian.getLinkedAccountId.mockResolvedValue(undefined);
    const res = await authed("/identity-link/atlassian/identity?subject=nobody");
    expect(res.status).toBe(404);
  });

  it("waits through the provider's linker", async () => {
    const res = await authed("/identity-link/atlassian/wait", {
      method: "POST",
      body: JSON.stringify({ subject: "openwebui:42", timeoutMs: 1000 }),
    });

    expect(await res.json()).toEqual({ status: "complete", token: { token: "atl-token" } });
  });

  it("reports a timeout rather than a failure when nothing lands", async () => {
    atlassian.waitForCompletion.mockResolvedValue(undefined);
    const res = await authed("/identity-link/atlassian/wait", {
      method: "POST",
      body: JSON.stringify({ subject: "s", timeoutMs: 10 }),
    });

    expect(await res.json()).toEqual({ status: "timeout" });
  });

  it("completes the callback through the provider's linker", async () => {
    // Unauthenticated on purpose: this is the user's browser coming back from
    // the provider, not the orchestrator.
    const res = await fetch(`${base}/identity-link/atlassian/callback?state=st&code=cd`);

    expect(res.status).toBe(200);
    expect(atlassian.completeAuthCode).toHaveBeenCalledWith("st", "cd");
  });

  it("shows an expiry page when the callback cannot be completed", async () => {
    atlassian.completeAuthCode.mockResolvedValue(undefined);
    const res = await fetch(`${base}/identity-link/atlassian/callback?state=st&code=cd`);
    expect(res.status).toBe(400);
  });

  it("requires the bearer token on the orchestrator-facing routes", async () => {
    const res = await fetch(`${base}/identity-link/atlassian/token?subject=s`);
    expect(res.status).toBe(401);
  });
});
