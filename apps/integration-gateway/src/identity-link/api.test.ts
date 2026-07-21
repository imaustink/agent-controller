import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubIdentityResolver } from "../identity.js";
import type { OrchestratorClient } from "../orchestrator-client.js";
import type { GithubReplyClient } from "../github-client.js";
import { GatewayServer } from "../server.js";
import type { GithubDeviceFlowLinker } from "./device-flow-linker.js";

const TOKEN = "test-identity-link-token";

describe("GatewayServer identity-link routes", () => {
  let server: GatewayServer;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let poll: ReturnType<typeof vi.fn>;
  let getValidToken: ReturnType<typeof vi.fn>;
  let startAuthCode: ReturnType<typeof vi.fn>;
  let completeAuthCode: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    start = vi.fn().mockResolvedValue({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
      deviceCode: "dc-1",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    poll = vi.fn().mockResolvedValue({ status: "complete" });
    getValidToken = vi.fn().mockResolvedValue({ token: "gho_abc", githubLogin: "octocat" });
    startAuthCode = vi.fn().mockResolvedValue({
      flow: "authcode",
      authorizeUrl: "https://github.com/login/oauth/authorize?client_id=client-1&state=xyz",
      expiresInSeconds: 600,
    });
    completeAuthCode = vi.fn().mockResolvedValue({ subject: "user-1" });

    server = new GatewayServer({
      githubWebhookSecret: "unused",
      identityResolver: {} as unknown as GithubIdentityResolver,
      orchestratorClient: {} as unknown as OrchestratorClient,
      githubReplyClient: {} as unknown as GithubReplyClient,
      identityLinkLinker: { start, poll, getValidToken, startAuthCode, completeAuthCode } as unknown as GithubDeviceFlowLinker,
      identityLinkToken: TOKEN,
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  function url(path: string): string {
    return `http://localhost:${port}${path}`;
  }

  it("rejects requests with no bearer token", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      body: JSON.stringify({ subject: "user-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on an unsupported provider", async () => {
    const res = await fetch(url("/identity-link/bitbucket/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on a missing subject field", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on malformed JSON", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("starts a device-flow link", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flow: "device",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
      deviceCode: "dc-1",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    expect(start).toHaveBeenCalledWith("user-1");
  });

  it("400s on an invalid flow value", async () => {
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1", flow: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("starts an authcode-flow link when flow is authcode", async () => {
    startAuthCode.mockResolvedValue({
      flow: "authcode",
      authorizeUrl: "https://github.com/login/oauth/authorize?client_id=client-1&state=xyz",
      expiresInSeconds: 600,
    });
    const res = await fetch(url("/identity-link/github/start"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1", flow: "authcode" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flow: "authcode",
      authorizeUrl: "https://github.com/login/oauth/authorize?client_id=client-1&state=xyz",
      expiresInSeconds: 600,
    });
    expect(startAuthCode).toHaveBeenCalledWith("user-1");
  });

  it("polls a device-flow link", async () => {
    const res = await fetch(url("/identity-link/github/poll"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1", deviceCode: "dc-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "complete" });
    expect(poll).toHaveBeenCalledWith("user-1", "dc-1");
  });

  it("400s poll on a missing deviceCode field", async () => {
    const res = await fetch(url("/identity-link/github/poll"), {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: "user-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a valid token for a linked subject", async () => {
    const res = await fetch(url("/identity-link/github/token?subject=user-1"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gho_abc", githubLogin: "octocat" });
    expect(getValidToken).toHaveBeenCalledWith("user-1");
  });

  it("404s when the subject has no link", async () => {
    getValidToken.mockResolvedValue(undefined);
    const res = await fetch(url("/identity-link/github/token?subject=nobody"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("GatewayServer identity-link authcode callback", () => {
  let server: GatewayServer;
  let port: number;
  let completeAuthCode: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    completeAuthCode = vi.fn().mockResolvedValue({ subject: "user-1" });

    server = new GatewayServer({
      githubWebhookSecret: "unused",
      identityResolver: {} as unknown as GithubIdentityResolver,
      orchestratorClient: {} as unknown as OrchestratorClient,
      githubReplyClient: {} as unknown as GithubReplyClient,
      identityLinkLinker: {
        start: vi.fn(),
        poll: vi.fn(),
        getValidToken: vi.fn(),
        startAuthCode: vi.fn(),
        completeAuthCode,
      } as unknown as GithubDeviceFlowLinker,
      identityLinkToken: TOKEN,
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  function url(path: string): string {
    return `http://localhost:${port}${path}`;
  }

  it("completes the link with no bearer header required", async () => {
    const res = await fetch(url("/identity-link/github/callback?code=the-code&state=the-state"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("GitHub account linked");
    expect(completeAuthCode).toHaveBeenCalledWith("the-state", "the-code");
  });

  it("400s when state is missing", async () => {
    const res = await fetch(url("/identity-link/github/callback?code=the-code"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(completeAuthCode).not.toHaveBeenCalled();
  });

  it("handles GitHub's access_denied redirect gracefully", async () => {
    const res = await fetch(url("/identity-link/github/callback?error=access_denied&state=the-state"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("declined");
    expect(completeAuthCode).not.toHaveBeenCalled();
  });

  it("400s when code and error are both missing", async () => {
    const res = await fetch(url("/identity-link/github/callback?state=the-state"));
    expect(res.status).toBe(400);
    expect(completeAuthCode).not.toHaveBeenCalled();
  });

  it("400s with a friendly page when completeAuthCode returns undefined", async () => {
    completeAuthCode.mockResolvedValue(undefined);
    const res = await fetch(url("/identity-link/github/callback?code=the-code&state=the-state"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });

  it("400s on an unsupported provider", async () => {
    const res = await fetch(url("/identity-link/bitbucket/callback?code=the-code&state=the-state"));
    expect(res.status).toBe(400);
    expect(completeAuthCode).not.toHaveBeenCalled();
  });
});
