import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeTokenStore } from "./claude-auth/store.js";
import type { GithubReplyClient } from "./github-client.js";
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
      githubReviewLabel: "ai-review",
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

  it("never resolves identity or invokes the orchestrator for an unlabeled issues.opened event", async () => {
    const resolve = vi.spyOn(identityResolver, "resolve");
    const res = await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("still ignores issues.opened even when the trigger label is already attached at creation time", async () => {
    const res = await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: {
        number: 7,
        title: "Add dark mode",
        body: "Please add a dark theme option.",
        labels: [{ name: "ai-triage" }],
      },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("never invokes the orchestrator for an issue_comment.created event, regardless of sender", async () => {
    const res = await postWebhook(port, "issue_comment", {
      action: "created",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7 },
      comment: { body: "start work" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("resolves identity with the event's repo context on issues.labeled", async () => {
    const resolve = vi.spyOn(identityResolver, "resolve");
    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
      label: { name: "ai-triage" },
    });
    await flush();
    expect(resolve).toHaveBeenCalledWith("alice", false, { owner: "acme", repo: "widgets" });
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
      undefined,
      undefined,
    );
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "What repo/branch should this target?");
  });

  it("ignores a pull_request.labeled event when the label isn't the configured review label", async () => {
    const res = await postWebhook(port, "pull_request", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      pull_request: { number: 12, title: "t", body: "b" },
      label: { name: "bug" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("relays a pull_request.labeled event with an event descriptor when the review label is applied", async () => {
    const res = await postWebhook(port, "pull_request", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      pull_request: { number: 12, title: "Add dark mode", body: "Implements the dark theme." },
      label: { name: "ai-review" },
    });
    expect(res.status).toBe(202);
    await flush();

    expect(invoke).toHaveBeenCalledWith(
      'Pull request #12 was labeled "ai-review": Add dark mode\n\nImplements the dark theme.',
      sessionIdFor("acme", "widgets", 12),
      "device",
      {
        source: "github",
        event: "pull_request",
        action: "labeled",
        owner: "acme",
        repo: "widgets",
        prNumber: 12,
        title: "Add dark mode",
        body: "Implements the dark theme.",
        senderLogin: "alice",
        labelName: "ai-review",
      },
      undefined,
      undefined,
    );
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 12, "What repo/branch should this target?");
  });

  it("drops a pull_request.labeled review trigger from an unknown identity (e.g. the bot that opened the PR)", async () => {
    const res = await postWebhook(port, "pull_request", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "agent-controller[bot]", type: "Bot" },
      pull_request: { number: 12, title: "t", body: "b" },
      label: { name: "ai-review" },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
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
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "t", body: "b" },
      label: { name: "ai-triage" },
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
  let checkLive: ReturnType<typeof vi.fn>;
  let postIssueComment: ReturnType<typeof vi.fn>;
  let sessionPageStore: InMemorySessionPageStore;

  beforeEach(async () => {
    identityResolver = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "agent-controller[bot]");
    // Simulate the real client's onRunning callback (5th arg): it fires once the
    // turn is genuinely running, which is what drives the deferred "starting
    // work" comment. A plain mockResolvedValue would never post it.
    invoke = vi.fn().mockImplementation(async (..._args: unknown[]) => {
      const onRunning = _args[4];
      if (typeof onRunning === "function") await (onRunning as () => Promise<void> | void)();
      return { status: "succeeded", result: "Working on it." };
    });
    // Not-live by default -- these tests exercise the #83 turn-history
    // fallback path; live-mode behavior has its own describe block below.
    checkLive = vi.fn().mockResolvedValue({ live: false });
    postIssueComment = vi.fn().mockResolvedValue(undefined);
    sessionPageStore = new InMemorySessionPageStore();

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke, checkLive } as unknown as OrchestratorClient,
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

  it("does nothing for an unlabeled issues.opened event, even with a session page store configured", async () => {
    await postWebhook(port, "issues", {
      action: "opened",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 9, title: "t", body: "b" },
    });
    await flush();

    expect(invoke).not.toHaveBeenCalled();
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it("links the starting-work comment to the Remote Control URL when it arrives before the turn is running", async () => {
    invoke.mockImplementation(async (..._args: unknown[]) => {
      const onRunning = _args[4] as (() => Promise<void> | void) | undefined;
      const onRemoteControlUrl = _args[5] as ((url: string) => Promise<void> | void) | undefined;
      // Simulate the remote-control-url progress event landing before the
      // turn is reported as running -- e.g. both surface on the same poll.
      await onRemoteControlUrl?.("https://claude.ai/code/session_abc123");
      await onRunning?.();
      return { status: "succeeded", result: "Working on it." };
    });

    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    // Only two comments -- no separate "Remote Control session available"
    // follow-up, since the URL was already known before the first comment posted.
    expect(postIssueComment).toHaveBeenCalledTimes(2);
    expect(postIssueComment).toHaveBeenNthCalledWith(
      1,
      "acme",
      "widgets",
      7,
      "Starting work on this now. Track progress or send follow-up prompts at https://claude.ai/code/session_abc123",
    );
    expect(postIssueComment).toHaveBeenNthCalledWith(2, "acme", "widgets", 7, "Working on it.");
  });

  it("posts a follow-up comment linking the Remote Control URL when it arrives after the starting-work comment already posted", async () => {
    invoke.mockImplementation(async (..._args: unknown[]) => {
      const onRunning = _args[4] as (() => Promise<void> | void) | undefined;
      const onRemoteControlUrl = _args[5] as ((url: string) => Promise<void> | void) | undefined;
      await onRunning?.();
      await onRemoteControlUrl?.("https://claude.ai/code/session_xyz789");
      return { status: "succeeded", result: "Working on it." };
    });

    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    expect(postIssueComment).toHaveBeenCalledTimes(3);
    expect(postIssueComment).toHaveBeenNthCalledWith(
      1,
      "acme",
      "widgets",
      7,
      expect.stringMatching(/^Starting work on this now.*https:\/\/gateway\.example\.com\/sessions\/\S+$/),
    );
    expect(postIssueComment).toHaveBeenNthCalledWith(
      2,
      "acme",
      "widgets",
      7,
      "Remote Control session available: https://claude.ai/code/session_xyz789",
    );
    expect(postIssueComment).toHaveBeenNthCalledWith(3, "acme", "widgets", 7, "Working on it.");
  });

  it("falls back to the session-page link exactly as before when no Remote Control URL ever arrives", async () => {
    // Default `invoke` mock from beforeEach never calls onRemoteControlUrl.
    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    expect(postIssueComment).toHaveBeenCalledTimes(2);
    expect(postIssueComment).toHaveBeenNthCalledWith(
      1,
      "acme",
      "widgets",
      7,
      expect.stringMatching(/^Starting work on this now.*https:\/\/gateway\.example\.com\/sessions\/\S+$/),
    );
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

    expect(invoke).toHaveBeenCalledWith(
      "actually, target the develop branch",
      "github:acme/widgets#7",
      "device",
      undefined,
      undefined,
      undefined,
    );
    expect(postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Working on it.");
    const updated = await sessionPageStore.getByToken(entry.token);
    expect(updated?.turns).toHaveLength(1);
    expect(updated?.turns[0]).toMatchObject({ status: "succeeded", result: "Working on it." });
  });
});

describe("GatewayServer unauthenticated triage: deferred ack + auto-resume", () => {
  let server: GatewayServer;
  let port: number;
  let invoke: ReturnType<typeof vi.fn>;
  let postIssueComment: ReturnType<typeof vi.fn>;
  let waitForCompletion: ReturnType<typeof vi.fn>;
  let sessionPageStore: InMemorySessionPageStore;

  beforeEach(async () => {
    const identityResolver = new GithubIdentityResolver(
      new Map([["alice", { subject: "alice", roles: ["reporter"] }]]),
      "agent-controller[bot]",
    );
    // First invoke: caller isn't linked -> the turn's "result" is a link
    // prompt (identityLinkPending), and onRunning is NOT fired. Second invoke
    // (the auto-resume, after the link lands): fires onRunning and returns the
    // real result.
    let call = 0;
    invoke = vi.fn().mockImplementation(async (..._args: unknown[]) => {
      const onRunning = _args[4];
      call += 1;
      if (call === 1) {
        return {
          status: "succeeded",
          identityLinkPending: true,
          identityLink: { provider: "claude", subject: "client-integration-gateway" },
          result: "To continue, please [link your Claude account](https://gateway.example.com/claude-auth/abc).",
        };
      }
      if (typeof onRunning === "function") await (onRunning as () => Promise<void> | void)();
      return { status: "succeeded", result: "Opened PR #42." };
    });
    postIssueComment = vi.fn().mockResolvedValue(undefined);
    waitForCompletion = vi.fn().mockResolvedValue({ token: "sk-ant-oat01-linked", createdAt: "2026-01-01T00:00:00Z" });
    sessionPageStore = new InMemorySessionPageStore();

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver,
      orchestratorClient: { invoke, checkLive: vi.fn().mockResolvedValue({ live: false }) } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment } as unknown as GithubReplyClient,
      githubTriggerLabel: "ai-triage",
      sessionPageStore,
      publicBaseUrl: "https://gateway.example.com",
      claudeAuthStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), waitForCompletion } as unknown as ClaudeTokenStore,
    });
    await server.listen(0);
    port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  });

  afterEach(async () => {
    await server.close();
  });

  it("posts the auth prompt FIRST (no premature 'starting work'), then waits for the link and auto-resumes the same request", async () => {
    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    // The very first comment is the auth prompt -- NOT a "starting work" ack.
    expect(postIssueComment.mock.calls[0]?.[3]).toMatch(/link your Claude account/i);
    expect(postIssueComment.mock.calls[0]?.[3]).not.toMatch(/starting work/i);
    // Then, after the link lands, "starting work" and the real result follow.
    expect(postIssueComment.mock.calls[1]?.[3]).toMatch(/^Starting work on this now/);
    expect(postIssueComment.mock.calls[2]?.[3]).toBe("Opened PR #42.");

    // Waited on the gateway-owned claude token store for the gateway subject,
    // and re-invoked the SAME triage request once it landed.
    expect(waitForCompletion).toHaveBeenCalledWith("client-integration-gateway", 10 * 60 * 1000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves the prompt standing (no resume) when the link is never completed in time", async () => {
    waitForCompletion.mockResolvedValueOnce(undefined);

    await postWebhook(port, "issues", {
      action: "labeled",
      repository: { owner: { login: "acme" }, name: "widgets" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, title: "Add dark mode", body: "Please add a dark theme option." },
      label: { name: "ai-triage" },
    });
    await flush();

    expect(postIssueComment).toHaveBeenCalledTimes(1);
    expect(postIssueComment.mock.calls[0]?.[3]).toMatch(/link your Claude account/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayServer live session tunnel (ADR 0026)", () => {
  let server: GatewayServer;
  let port: number;
  let checkLive: ReturnType<typeof vi.fn>;
  let openEventStream: ReturnType<typeof vi.fn>;
  let forwardOpencode: ReturnType<typeof vi.fn>;
  let sessionPageStore: InMemorySessionPageStore;

  beforeEach(async () => {
    checkLive = vi.fn();
    openEventStream = vi.fn();
    forwardOpencode = vi.fn();
    sessionPageStore = new InMemorySessionPageStore();

    server = new GatewayServer({
      githubWebhookSecret: SECRET,
      identityResolver: new GithubIdentityResolver(new Map(), "agent-controller[bot]"),
      orchestratorClient: { checkLive, openEventStream, forwardOpencode } as unknown as OrchestratorClient,
      githubReplyClient: { postIssueComment: vi.fn() } as unknown as GithubReplyClient,
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

  it("renders the live badge and caches the discovered agentRunId when checkLive reports live", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    checkLive.mockResolvedValue({ live: true, agentRunId: "run-42" });

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("LIVE");
    expect(html).toContain(`/sessions/${entry.token}/live-events`);
    expect(html).toContain(`action="/sessions/${entry.token}/live-prompt"`);

    const updated = await sessionPageStore.getByToken(entry.token);
    expect(updated?.live).toEqual({ agentRunId: "run-42" });
  });

  it("clears cached live info once checkLive stops reporting live", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    checkLive.mockResolvedValue({ live: false });

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}`);
    const html = await res.text();
    expect(html).not.toContain("LIVE");

    const updated = await sessionPageStore.getByToken(entry.token);
    expect(updated?.live).toBeUndefined();
  });

  it("proxies the live event stream to the browser", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    openEventStream.mockResolvedValue(
      new Response(new TextEncoder().encode('data: {"type":"message.part.updated"}\n\n'), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}/live-events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe('data: {"type":"message.part.updated"}\n\n');
    expect(openEventStream).toHaveBeenCalledWith("run-42", "github:acme/widgets#7");
  });

  it("404s the live-events route when the session isn't cached as live", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}/live-events`);
    expect(res.status).toBe(404);
  });

  it("discovers and caches the opencode session id on first live prompt, reusing it thereafter", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    forwardOpencode.mockImplementation((_runId: string, _sessionId: string, req: { method: string; path: string }) => {
      if (req.path === "/session") return Promise.resolve({ status: 200, body: [{ id: "ses_abc123" }] });
      return Promise.resolve({ status: 204 });
    });

    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}/live-prompt`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "also fix the tests" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    await flush();

    expect(forwardOpencode).toHaveBeenNthCalledWith(1, "run-42", "github:acme/widgets#7", { method: "GET", path: "/session" });
    expect(forwardOpencode).toHaveBeenNthCalledWith(2, "run-42", "github:acme/widgets#7", {
      method: "POST",
      path: "/session/ses_abc123/prompt_async",
      body: { parts: [{ type: "text", text: "also fix the tests" }] },
    });
    expect((await sessionPageStore.getByToken(entry.token))?.live).toEqual({ agentRunId: "run-42", opencodeSessionId: "ses_abc123" });

    forwardOpencode.mockClear();
    await fetch(`http://localhost:${port}/sessions/${entry.token}/live-prompt`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "one more thing" }).toString(),
    });
    await flush();
    expect(forwardOpencode).toHaveBeenCalledTimes(1);
    expect(forwardOpencode).toHaveBeenCalledWith("run-42", "github:acme/widgets#7", {
      method: "POST",
      path: "/session/ses_abc123/prompt_async",
      body: { parts: [{ type: "text", text: "one more thing" }] },
    });
  });

  it("404s the live-prompt route when the session isn't cached as live", async () => {
    const entry = await sessionPageStore.getOrCreate("github:acme/widgets#7", { owner: "acme", repo: "widgets", issueNumber: 7 });
    const res = await fetch(`http://localhost:${port}/sessions/${entry.token}/live-prompt`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "hi" }).toString(),
    });
    expect(res.status).toBe(404);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
