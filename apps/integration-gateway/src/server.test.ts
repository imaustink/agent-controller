import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLY_MARKER, type GithubReplyClient } from "./github-client.js";
import { GithubIdentityResolver } from "./identity.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { GatewayServer, sessionIdFor } from "./server.js";
import { InMemorySessionPageStore } from "./session-page-store.js";

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

describe("GatewayServer session pages", () => {
  let server: GatewayServer;
  let port: number;
  let identityResolver: GithubIdentityResolver;
  let invoke: ReturnType<typeof vi.fn>;
  let postIssueComment: ReturnType<typeof vi.fn>;
  let sessionPageStore: InMemorySessionPageStore;

  beforeEach(async () => {
    identityResolver = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "agent-controller[bot]");
    invoke = vi.fn().mockResolvedValue({ status: "succeeded", result: "Working on it." });
    postIssueComment = vi.fn().mockResolvedValue(undefined);
    sessionPageStore = new InMemorySessionPageStore();

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment } as unknown as GithubReplyClient,
      githubTriggerLabel: "ai-triage",
      sessionPageStore,
      publicBaseUrl: "https://gateway.example.com",
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  it("posts a starting-work comment with a session page link before the labeled-triage turn completes, then the result", async () => {
    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    expect(postIssueComment).toHaveBeenNthCalledWith(
      1,
      "acme",
      "widgets",
      7,
      expect.stringMatching(/^Starting work on this now.*https:\/\/gateway\.example\.com\/sessions\/\S+$/),
    );
    expect(postIssueComment).toHaveBeenNthCalledWith(2, "acme", "widgets", 7, "Working on it.");

    const entry = await sessionPageStore.getOrCreate(sessionIdFor("acme", "widgets", 7), {
      owner: "acme",
      repo: "widgets",
      issueNumber: 7,
    });
    expect(entry.turns).toHaveLength(1);
    expect(entry.turns[0]).toMatchObject({ status: "succeeded", result: "Working on it." });
  });

  it("does not post a session page link for plain (non-labeled) conversational replies", async () => {
    await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 9, title: "t", body: "b" },
    });
    await flush();

    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 9, "Working on it.");
  });

  it("serves the rendered session page for a valid token", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await sessionPageStore.addTurn(entry.sessionId, "do the thing");

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("acme/widgets #7");
    expect(html).toContain("do the thing");
  });

  it("404s on an unknown session page token", async () => {
    const res = await fetch(`http://localhost:${port}/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("accepts a follow-up prompt submitted through the session page and relays it into the same session", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "actually, target the develop branch" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sessions/${entry.token}`);
    await flush();

    expect(invoke).toHaveBeenCalledWith("actually, target the develop branch", "github:acme/widgets#7", "device");
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Working on it.");
    const updated = await sessionPageStore.getByToken(entry.token);
    expect(updated?.turns).toHaveLength(1);
    expect(updated?.turns[0]).toMatchObject({ status: "succeeded", result: "Working on it." });
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
