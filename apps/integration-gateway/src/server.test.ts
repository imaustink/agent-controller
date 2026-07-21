import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLY_MARKER, type GithubReplyClient } from "./github-client.js";
import { GithubIdentityResolver } from "./identity.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { GatewayServer, sessionIdFor } from "./server.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function postWebhook(
  port: number,
  eventName: string,
  payload: unknown,
  opts: { badSignature?: boolean; noSignature?: boolean } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-github-event": eventName, "content-type": "application/json" };
  if (!opts.noSignature) headers["x-hub-signature-256"] = opts.badSignature ? sign("tampered") : sign(body);
  return fetch(`http://localhost:${port}/webhooks/github`, { method: "POST", headers, body });
}

describe("GatewayServer", () => {
  let server: GatewayServer;
  let port: number;
  let identityResolver: GithubIdentityResolver;
  let invoke: ReturnType<typeof vi.fn>;
  let postIssueComment: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    identityResolver = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "agent-controller[bot]");
    invoke = vi.fn().mockResolvedValue({ status: "succeeded", result: "What repo/branch should this target?" });
    postIssueComment = vi.fn().mockResolvedValue(undefined);

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment } as unknown as GithubReplyClient,
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  it("responds to healthz without needing a signature", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("rejects a request with a missing signature", async () => {
    const res = await postWebhook(port, "issues", { action: "opened" }, { noSignature: true });
    expect(res.status).toBe(401);
  });

  it("rejects a request with a bad signature", async () => {
    const res = await postWebhook(port, "issues", { action: "opened" }, { badSignature: true });
    expect(res.status).toBe(401);
  });

  it("acks unrecognized events without invoking the orchestrator", async () => {
    const res = await postWebhook(port, "pull_request", { action: "opened" });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops events from an unknown GitHub identity", async () => {
    const res = await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "mallory", type: "User" },
      issue: { number: 1, title: "t", body: "b" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops the gateway's own bot comments (loop guard)", async () => {
    const res = await postWebhook(port, "issue_comment", {
      action: "created",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "agent-controller[bot]", type: "Bot" },
      issue: { number: 1 },
      comment: { body: `${REPLY_MARKER}\nprevious reply` },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("relays an issues.opened event to the orchestrator, scoped by session id, and posts the reply", async () => {
    const res = await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
    });
    expect(res.status).toBe(202);
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      "Add dark mode\n\nPlease add a dark theme option.",
      sessionIdFor("acme", "widgets", 7),
      "device",
    );
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "What repo/branch should this target?");
  });

  it("relays an issue_comment.created follow-up on the same session id", async () => {
    await postWebhook(port, "issue_comment", {
      action: "created",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7 },
      comment: { body: "start work" },
    });
    await flush();
    expect(invoke).toHaveBeenCalledWith("start work", sessionIdFor("acme", "widgets", 7), "device");
  });

  it("posts a failure-explaining comment when the orchestrator turn fails", async () => {
    invoke.mockResolvedValue({ status: "failed", error: "boom" });
    await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
    });
    await flush();
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, expect.stringContaining("boom"));
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
