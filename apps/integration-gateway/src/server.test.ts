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
      githubTriggerLabel: "ai-triage",
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

  it("resolves identity with the event's repo context", async () => {
    const resolve = vi.spyOn(identityResolver, "resolve");
    await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
    });
    await flush();
    expect(resolve).toHaveBeenCalledWith("alice", false, { owner: "acme", repo: "widgets" });
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

  it("ignores an issues.labeled event when the label isn't the configured trigger label", async () => {
    const res = await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
      label: { name: "bug" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("relays an issues.labeled event to the orchestrator with an event descriptor when the trigger label is applied", async () => {
    const res = await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    expect(res.status).toBe(202);
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      'Issue #7 was labeled "ai-triage": Add dark mode\n\nPlease add a dark theme option.',
      sessionIdFor("acme", "widgets", 7),
      "device",
      {
        source: "github",
        event: "issues",
        action: "labeled",
        owner: "acme",
        repo: "widgets",
        issueNumber: 7,
        title: "Add dark mode",
        body: "Please add a dark theme option.",
        senderLogin: "alice",
        labelName: "ai-triage",
      },
    );
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "What repo/branch should this target?");
  });

  it("posts an upfront 'starting work' comment before relaying an issues.labeled trigger to the orchestrator", async () => {
    const res = await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    expect(res.status).toBe(202);
    await flush();

    expect(postIssueComment).toHaveBeenCalledTimes(2);
    expect(postIssueComment).toHaveBeenNthCalledWith(1, "acme", "widgets", 7, expect.stringContaining("starting to look into this"));
    expect(postIssueComment).toHaveBeenNthCalledWith(2, "acme", "widgets", 7, "What repo/branch should this target?");
    // The starting comment is posted (and settles) before the orchestrator
    // is even invoked -- not just before the final reply comment.
    expect(postIssueComment.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0] as number);
  });

  it("drops an issues.labeled event from an unknown GitHub identity even with the trigger label", async () => {
    const res = await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "mallory", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
      label: { name: "ai-triage" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
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

describe("GatewayServer session viewer", () => {
  const SESSION_VIEWER_SECRET = "viewer-secret";
  const SESSION_VIEWER_BASE_URL = "https://gateway.example.com";

  let server: GatewayServer;
  let port: number;
  let identityResolver: GithubIdentityResolver;
  let invoke: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let postIssueComment: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    identityResolver = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "agent-controller[bot]");
    invoke = vi.fn().mockResolvedValue({ status: "succeeded", result: "Opened PR #12" });
    getSession = vi.fn().mockResolvedValue(undefined);
    postIssueComment = vi.fn().mockResolvedValue(undefined);

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke, getSession } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment } as unknown as GithubReplyClient,
      githubTriggerLabel: "ai-triage",
      sessionViewer: { baseUrl: SESSION_VIEWER_BASE_URL, secret: SESSION_VIEWER_SECRET },
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  function signToken(sessionId: string): string {
    return createHmac("sha256", SESSION_VIEWER_SECRET).update(sessionId).digest("hex").slice(0, 32);
  }

  it("includes a session-viewer link in the upfront starting-work comment", async () => {
    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    const sessionId = sessionIdFor("acme", "widgets", 7);
    const expectedUrl = `${SESSION_VIEWER_BASE_URL}/sessions/${encodeURIComponent(sessionId)}?token=${signToken(sessionId)}`;
    expect(postIssueComment).toHaveBeenNthCalledWith(1, "acme", "widgets", 7, expect.stringContaining(expectedUrl));
  });

  it("404s GET /sessions/:id without a valid token", async () => {
    const sessionId = sessionIdFor("acme", "widgets", 7);
    const noToken = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}`);
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}?token=deadbeef`);
    expect(wrongToken.status).toBe(401);
  });

  it("renders the session-viewer HTML page for a valid token", async () => {
    const sessionId = sessionIdFor("acme", "widgets", 7);
    getSession.mockResolvedValue({
      sessionId,
      pending: false,
      transcript: [{ role: "agent", text: "Opened PR #12", at: Date.now() }],
    });

    const res = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}?token=${signToken(sessionId)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Opened PR #12");
    expect(getSession).toHaveBeenCalledWith(sessionId);
  });

  it("rejects POST /sessions/:id/messages with an invalid token", async () => {
    const sessionId = sessionIdFor("acme", "widgets", 7);
    const res = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}/messages?token=nope`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=also+fix+the+footer",
    });
    expect(res.status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("relays a form-submitted prompt from the session viewer as a new turn and redirects back to the page", async () => {
    const sessionId = sessionIdFor("acme", "widgets", 7);
    const token = signToken(sessionId);
    const res = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}/messages?token=${token}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=also+fix+the+footer",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sessions/${encodeURIComponent(sessionId)}?token=${token}`);

    await flush();
    expect(invoke).toHaveBeenCalledWith("also fix the footer", sessionId, "device");
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Opened PR #12");
  });

  it("rejects an empty message body", async () => {
    const sessionId = sessionIdFor("acme", "widgets", 7);
    const res = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent(sessionId)}/messages?token=${signToken(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=",
    });
    expect(res.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("GatewayServer session viewer disabled (default)", () => {
  it("404s GET and POST /sessions/* when sessionViewer isn't configured", async () => {
    const identityResolver = new GithubIdentityResolver(new Map(), "agent-controller[bot]");
    const server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke: vi.fn() } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment: vi.fn() } as unknown as GithubReplyClient,
      githubTriggerLabel: "ai-triage",
    });
    await server.listen(0);
    const port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;

    const getRes = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent("github:acme/widgets#7")}`);
    expect(getRes.status).toBe(404);

    const postRes = await fetch(`http://localhost:${port}/sessions/${encodeURIComponent("github:acme/widgets#7")}/messages`, {
      method: "POST",
      body: "text=hi",
    });
    expect(postRes.status).toBe(404);

    await server.close();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
