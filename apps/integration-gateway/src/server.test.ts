import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBody, type Envelope, type EventSourceResource } from "@controller-agent/event-triggers";
import type { ClaudeTokenStore } from "./claude-auth/store.js";
import { StaticEventSourceRegistry, type SecretLookup } from "./event-sources.js";
import type { GithubReplyClient } from "./github-client.js";
import { GithubIdentityResolver } from "./identity.js";
import { InMemoryPendingLabelStore } from "./label-reconciler.js";
import type { AcceptedTrigger, EventSubmitResult, OrchestratorClient, OrchestratorInvokeResult, PollHooks } from "./orchestrator-client.js";
import { GatewayServer, type GatewayServerOptions } from "./server.js";
import { InMemorySessionPageStore } from "./session-page-store.js";

// Wrapped so a test can prove verification rejected a request BEFORE anything
// parsed it -- the property the whole handler order exists for.
vi.mock("@controller-agent/event-triggers", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@controller-agent/event-triggers")>();
  return { ...mod, parseBody: vi.fn(mod.parseBody) };
});

/**
 * Every request in this file goes over a fresh TCP connection — see the long
 * explanation on the identical shim in agent-orchestrator's `server.test.ts`.
 * Short version: these tests listen on ephemeral ports and close their servers,
 * and Node's `fetch` caches keep-alive sockets per origin, so a recycled port
 * can hand a later test a dead socket ("other side closed", zero bytes read).
 * `connection: close` keeps anything from being pooled in the first place.
 */
const nativeFetch = globalThis.fetch;
const fetch: typeof globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return nativeFetch(input, { ...init, headers });
};

const SECRETS: Record<string, string> = {
  "gh/secret": "gh-secret",
  "slack/secret": "slack-secret",
  "ci/token": "ci-token",
  "callback/secret": "callback-secret",
};

/** Tokens the fake TokenReview recognises, and who each one is. */
const NIGHTLY_TOKEN = "aaa.nightly.sig";
const OTHER_TOKEN = "aaa.other.sig";
const TICK_IDENTITIES: Record<string, string> = {
  [NIGHTLY_TOKEN]: "system:serviceaccount:agents:eventsource-nightly",
  [OTHER_TOKEN]: "system:serviceaccount:agents:eventsource-other",
  "aaa.wrongns.sig": "system:serviceaccount:elsewhere:eventsource-nightly",
  "aaa.github.sig": "system:serviceaccount:agents:eventsource-github",
};

const SOURCES: EventSourceResource[] = [
  {
    metadata: { name: "github" },
    spec: {
      webhook: {
        verify: { scheme: "hmacSha256", header: "x-hub-signature-256", prefix: "sha256=", secretRef: { name: "gh", key: "secret" } },
        deliveryIdHeader: "x-github-delivery",
      },
      sender: {
        provider: "github",
        loginFrom: "body.sender.login",
        isBotFrom: 'body.sender.type == "Bot"',
        repositoryFrom: "body.repository.full_name",
      },
    },
  },
  {
    metadata: { name: "plain" },
    spec: { webhook: { verify: { scheme: "hmacSha256", header: "x-sig", secretRef: { name: "gh", key: "secret" } } } },
  },
  {
    metadata: { name: "nokey" },
    spec: { webhook: { verify: { scheme: "hmacSha256", header: "x-sig", secretRef: { name: "absent", key: "secret" } } } },
  },
  { metadata: { name: "slack" }, spec: { webhook: { verify: { scheme: "slackV0", secretRef: { name: "slack", key: "secret" } } } } },
  { metadata: { name: "ci" }, spec: { webhook: { verify: { scheme: "bearer", secretRef: { name: "ci", key: "token" } } } } },
  {
    metadata: { name: "ci-custom" },
    spec: { webhook: { verify: { scheme: "bearer", header: "x-ci-token", secretRef: { name: "ci", key: "token" } } } },
  },
  { metadata: { name: "nightly" }, spec: { cron: { schedule: "0 7 * * *", payload: { repo: "acme/widgets", n: 3 } } } },
];

const DEFAULT_TRIGGER: AcceptedTrigger = {
  name: "github-review",
  sessionId: "github:acme/widgets#7",
  reply: {
    github: {
      repository: "acme/widgets",
      issueNumber: 7,
      ack: "Starting a review…",
      sessionPage: true,
      result: true,
      removeLabel: "ai-review",
    },
    http: { url: "http://ci-bridge.tools.svc/results", secretRef: { name: "callback", key: "secret" } },
  },
};

interface Harness {
  server: GatewayServer;
  port: number;
  order: string[];
  logs: string[];
  submitEvent: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  postIssueComment: ReturnType<typeof vi.fn>;
  removeIssueLabel: ReturnType<typeof vi.fn>;
  replyFetch: ReturnType<typeof vi.fn>;
  secretsGet: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.spyOn>;
  pendingLabelStore: InMemoryPendingLabelStore;
  record: ReturnType<typeof vi.spyOn>;
  clear: ReturnType<typeof vi.spyOn>;
  sessionPageStore: InMemorySessionPageStore;
  onBackgroundError: ReturnType<typeof vi.fn>;
}

let current: Harness | undefined;

afterEach(async () => {
  await current?.server.close();
  current = undefined;
  vi.mocked(parseBody).mockClear();
});

async function start(overrides: Partial<GatewayServerOptions> = {}, secrets: Record<string, string> = SECRETS): Promise<Harness> {
  const order: string[] = [];
  const logs: string[] = [];
  const identityResolver = new GithubIdentityResolver(new Map([["alice", { subject: "alice", roles: ["reporter"] }]]), "agent-controller[bot]");
  const resolve = vi.spyOn(identityResolver, "resolve");
  const submitEvent = vi.fn(async (): Promise<EventSubmitResult> => ({ kind: "accepted", id: "inv-1", trigger: DEFAULT_TRIGGER }));
  const poll = vi.fn(async (_id: string, _hooks?: PollHooks): Promise<OrchestratorInvokeResult> => {
    order.push("poll");
    return { status: "succeeded", result: "Looks good." };
  });
  const invoke = vi.fn(async (): Promise<OrchestratorInvokeResult> => ({ status: "succeeded", result: "Follow-up done." }));
  const postIssueComment = vi.fn(async (_o: string, _r: string, _n: number, body: string) => {
    order.push(`comment:${body.split("\n")[0]}`);
  });
  const removeIssueLabel = vi.fn(async () => {
    order.push("removeLabel");
  });
  const replyFetch = vi.fn(async () => {
    order.push("http");
    return new Response(null, { status: 204 });
  });
  const secretsGet = vi.fn(async (name: string, key: string) => secrets[`${name}/${key}`]);
  const pendingLabelStore = new InMemoryPendingLabelStore();
  const record = vi.spyOn(pendingLabelStore, "record").mockImplementation(async function (this: InMemoryPendingLabelStore, entry) {
    order.push("record");
    return InMemoryPendingLabelStore.prototype.record.call(pendingLabelStore, entry);
  });
  const clear = vi.spyOn(pendingLabelStore, "clear");
  const sessionPageStore = new InMemorySessionPageStore();
  const onBackgroundError = vi.fn();

  const server = new GatewayServer({
    eventSources: new StaticEventSourceRegistry(SOURCES, () => {}),
    secrets: { get: secretsGet } as SecretLookup,
    tickAuthenticator: { authenticate: async (token: string) => TICK_IDENTITIES[token] },
    tickNamespace: "agents",
    identityResolver,
    orchestratorClient: { submitEvent, poll, invoke, checkLive: vi.fn().mockResolvedValue({ live: false }) } as unknown as OrchestratorClient,
    githubReplyClient: { postIssueComment, removeIssueLabel } as unknown as GithubReplyClient,
    replyFetch: replyFetch as unknown as typeof fetch,
    log: (line) => logs.push(line),
    onBackgroundError,
    pendingLabelStore,
    // The reconciler's startup sweep must not race these tests' own removals.
    labelReconcilerGraceMs: 60 * 60 * 1000,
    sessionPageStore,
    publicBaseUrl: "https://gateway.example.com",
    ...overrides,
  });
  await server.listen(0);
  const port = (server as unknown as { server: { address: () => AddressInfo } }).server.address().port;
  current = {
    server,
    port,
    order,
    logs,
    submitEvent,
    poll,
    invoke,
    postIssueComment,
    removeIssueLabel,
    replyFetch,
    secretsGet,
    resolve,
    pendingLabelStore,
    record,
    clear,
    sessionPageStore,
    onBackgroundError,
  };
  return current;
}

const hmacHex = (secret: string, data: string): string => createHmac("sha256", secret).update(data).digest("hex");

const GITHUB_PAYLOAD = {
  action: "labeled",
  label: { name: "ai-review" },
  repository: { full_name: "acme/widgets" },
  sender: { login: "alice", type: "User" },
  pull_request: { number: 7 },
};

function postGithub(
  h: Harness,
  payload: unknown = GITHUB_PAYLOAD,
  opts: { signature?: string | null; extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-123",
    ...opts.extraHeaders,
  };
  if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? `sha256=${hmacHex("gh-secret", body)}`;
  return fetch(`http://localhost:${h.port}/webhooks/github`, { method: "POST", headers, body });
}

/** Lets the background relay run; used where the assertion is that something did NOT happen. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function submittedEnvelope(h: Harness, call = 0): Envelope {
  return h.submitEvent.mock.calls[call]?.[0] as Envelope;
}

describe("POST /webhooks/:source routing", () => {
  it("responds to healthz", async () => {
    const h = await start();
    expect((await fetch(`http://localhost:${h.port}/healthz`)).status).toBe(200);
  });

  it("404s an unknown source and a cron source, without reading a secret", async () => {
    const h = await start();
    for (const name of ["nope", "nightly", "NOT_A_K8S_NAME"]) {
      const res = await fetch(`http://localhost:${h.port}/webhooks/${name}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
    expect(h.secretsGet).not.toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("404s everything when no EventSources are configured", async () => {
    const h = await start({ eventSources: new StaticEventSourceRegistry([]) });
    expect((await postGithub(h)).status).toBe(404);
  });
});

describe("webhook verification (hmacSha256)", () => {
  it("401s a missing signature: nothing parsed, nothing resolved, nothing relayed", async () => {
    const h = await start();
    expect((await postGithub(h, GITHUB_PAYLOAD, { signature: null })).status).toBe(401);
    await settle();
    expect(parseBody).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/webhook github: rejected, verification failed \(missing x-hub-signature-256\)/);
  });

  it("401s a bad signature: nothing parsed, nothing relayed", async () => {
    const h = await start();
    const res = await postGithub(h, GITHUB_PAYLOAD, { signature: `sha256=${hmacHex("gh-secret", "tampered")}` });
    expect(res.status).toBe(401);
    await settle();
    expect(parseBody).not.toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("401s (fails closed) when the referenced Secret/key is missing", async () => {
    const h = await start();
    const body = "{}";
    const res = await fetch(`http://localhost:${h.port}/webhooks/nokey`, {
      method: "POST",
      headers: { "x-sig": hmacHex("", body) },
      body,
    });
    expect(res.status).toBe(401);
    await settle();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("accepts a just-rotated secret by re-reading once on mismatch", async () => {
    const h = await start();
    h.secretsGet.mockImplementation(async (name: string, key: string, opts?: { refresh?: boolean }) =>
      name === "gh" && key === "secret" ? (opts?.refresh ? "rotated" : "gh-secret") : undefined,
    );
    const body = JSON.stringify(GITHUB_PAYLOAD);
    const res = await postGithub(h, GITHUB_PAYLOAD, { signature: `sha256=${hmacHex("rotated", body)}` });
    expect(res.status).toBe(202);
  });

  it("accepts a valid signature with 202 and builds the envelope without the verify/authorization/cookie headers", async () => {
    const h = await start();
    const res = await postGithub(h, GITHUB_PAYLOAD, {
      extraHeaders: { authorization: "Bearer leak", cookie: "session=leak", "X-Custom": "kept" },
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    const envelope = submittedEnvelope(h);
    expect(envelope).toMatchObject({ source: "github", kind: "webhook", id: "delivery-123", body: GITHUB_PAYLOAD });
    expect(envelope.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(envelope.headers["x-github-event"]).toBe("pull_request");
    expect(envelope.headers["x-custom"]).toBe("kept");
    expect(envelope.headers).not.toHaveProperty("x-hub-signature-256");
    expect(envelope.headers).not.toHaveProperty("authorization");
    expect(envelope.headers).not.toHaveProperty("cookie");
  });
});

describe("webhook verification (slackV0)", () => {
  const slackPost = (h: Harness, payload: unknown, tsOffset = 0, secret = "slack-secret"): Promise<Response> => {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
    return fetch(`http://localhost:${h.port}/webhooks/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${hmacHex(secret, `v0:${ts}:${body}`)}`,
      },
      body,
    });
  };

  it("answers url_verification with its challenge synchronously and relays nothing", async () => {
    const h = await start();
    const res = await slackPost(h, { type: "url_verification", challenge: "chal-42" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "chal-42" });
    await settle();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("does not answer a url_verification it cannot verify", async () => {
    const h = await start();
    const res = await slackPost(h, { type: "url_verification", challenge: "chal-42" }, 0, "wrong");
    expect(res.status).toBe(401);
  });

  it("401s a stale timestamp (replay) without parsing", async () => {
    const h = await start();
    const res = await slackPost(h, { type: "event_callback" }, -301);
    expect(res.status).toBe(401);
    await settle();
    expect(parseBody).not.toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("relays a verified event without the signature header", async () => {
    const h = await start();
    expect((await slackPost(h, { type: "event_callback", event: { text: "hi" } })).status).toBe(202);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    const envelope = submittedEnvelope(h);
    expect(envelope.body).toEqual({ type: "event_callback", event: { text: "hi" } });
    expect(envelope.headers).not.toHaveProperty("x-slack-signature");
    expect(envelope.headers).toHaveProperty("x-slack-request-timestamp");
    // A source without `sender` forwards no login.
    expect(h.submitEvent.mock.calls[0]?.[1]).toBeUndefined();
  });
});

describe("webhook verification (bearer)", () => {
  it("default authorization header: 'Bearer <secret>' accepted, anything else 401", async () => {
    const h = await start();
    const post = (auth: string): Promise<Response> =>
      fetch(`http://localhost:${h.port}/webhooks/ci`, { method: "POST", headers: { authorization: auth, "content-type": "text/plain" }, body: "build ok" });
    expect((await post("Bearer wrong")).status).toBe(401);
    expect((await post("ci-token")).status).toBe(401);
    expect((await post("Bearer ci-token")).status).toBe(202);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalledTimes(1));
    const envelope = submittedEnvelope(h);
    expect(envelope.body).toEqual({ text: "build ok" });
    expect(envelope.headers).not.toHaveProperty("authorization");
  });

  it("custom header carries the raw secret and is dropped from the envelope", async () => {
    const h = await start();
    const res = await fetch(`http://localhost:${h.port}/webhooks/ci-custom`, {
      method: "POST",
      headers: { "x-ci-token": "ci-token", "content-type": "application/x-www-form-urlencoded" },
      body: "status=green",
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    const envelope = submittedEnvelope(h);
    expect(envelope.body).toEqual({ status: "green" });
    expect(envelope.headers).not.toHaveProperty("x-ci-token");
  });
});

describe("sender verification", () => {
  it("forwards a VERIFIED login with the signed-assertion path, in envelope.sender, with repo context", async () => {
    const h = await start();
    await postGithub(h);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    expect(h.resolve).toHaveBeenCalledWith("alice", false, { owner: "acme", repo: "widgets" });
    expect(h.submitEvent.mock.calls[0]?.[1]).toBe("alice");
    const envelope = submittedEnvelope(h);
    expect(envelope.sender).toEqual({ login: "alice", isBot: false });
    expect(envelope.repository).toBe("acme/widgets");
  });

  it("drops a bot-authored event (202 + log line) without resolving or relaying", async () => {
    const h = await start();
    const res = await postGithub(h, { ...GITHUB_PAYLOAD, sender: { login: "agent-controller[bot]", type: "Bot" } });
    expect(res.status).toBe(202);
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/webhook github event delivery-123: dropped \(sender agent-controller\[bot\] is a bot\)/);
  });

  it("drops an unresolved sender (202 + log line)", async () => {
    const h = await start();
    const res = await postGithub(h, { ...GITHUB_PAYLOAD, sender: { login: "mallory", type: "User" } });
    expect(res.status).toBe(202);
    await settle();
    expect(h.resolve).toHaveBeenCalled();
    expect(h.submitEvent).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/dropped \(sender mallory not verified by provider github\)/);
  });

  it("drops an event whose loginFrom cannot be evaluated (fail closed)", async () => {
    const h = await start();
    expect((await postGithub(h, { action: "ping" })).status).toBe(202);
    await settle();
    expect(h.submitEvent).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/dropped \(sender.loginFrom failed/);
  });

  it("a source without `sender` forwards no login and an empty sender, even if the body names one", async () => {
    const h = await start();
    const body = JSON.stringify(GITHUB_PAYLOAD);
    await fetch(`http://localhost:${h.port}/webhooks/plain`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sig": hmacHex("gh-secret", body) },
      body,
    });
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.submitEvent.mock.calls[0]?.[1]).toBeUndefined();
    expect(submittedEnvelope(h).sender).toEqual({});
    expect(submittedEnvelope(h).repository).toBe("");
  });
});

describe("/invoke outcomes drive exactly the declared side effects", () => {
  it("ignored: logs and does nothing else", async () => {
    const h = await start();
    h.submitEvent.mockResolvedValueOnce({ kind: "ignored" });
    await postGithub(h);
    await vi.waitFor(() => expect(h.logs.join("\n")).toMatch(/no trigger matched \(ignored\)/));
    await settle();
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.postIssueComment).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.removeIssueLabel).not.toHaveBeenCalled();
    expect(h.replyFetch).not.toHaveBeenCalled();
  });

  it("422: logs and does nothing else", async () => {
    const h = await start();
    h.submitEvent.mockResolvedValueOnce({ kind: "rejected", error: "issueNumber did not render to a positive integer" });
    await postGithub(h);
    await vi.waitFor(() => expect(h.logs.join("\n")).toMatch(/\(422\): issueNumber did not render/));
    await settle();
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.postIssueComment).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.removeIssueLabel).not.toHaveBeenCalled();
    expect(h.replyFetch).not.toHaveBeenCalled();
  });

  it("202: records the owed label, acks (with session page link), polls, posts the result, calls back, removes the label -- in that order", async () => {
    const h = await start();
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    expect(h.order).toEqual(["record", "comment:Starting a review…", "poll", "comment:Looks good.", "http", "removeLabel"]);

    const ack = h.postIssueComment.mock.calls[0];
    expect(ack?.slice(0, 3)).toEqual(["acme", "widgets", 7]);
    const token = /https:\/\/gateway\.example\.com\/sessions\/([A-Za-z0-9_-]+)/.exec(ack?.[3] as string)?.[1];
    expect(token).toBeDefined();
    const entry = await h.sessionPageStore.getByToken(token!);
    expect(entry).toMatchObject({ sessionId: "github:acme/widgets#7", owner: "acme", repo: "widgets", issueNumber: 7 });
    expect(entry?.turns).toHaveLength(1);
    expect(entry?.turns[0]).toMatchObject({ status: "succeeded", result: "Looks good." });

    expect(h.poll).toHaveBeenCalledWith("inv-1", expect.anything());
    expect(h.removeIssueLabel).toHaveBeenCalledWith("acme", "widgets", 7, "ai-review");
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repo: "widgets", issueNumber: 7, label: "ai-review", sessionId: "github:acme/widgets#7" }));
    expect(h.clear).toHaveBeenCalledWith("github:acme/widgets#7", "ai-review");
    expect(await h.pendingLabelStore.list()).toEqual([]);
  });

  it("http reply: exact body, signature verifiable with the trigger's secret, literal url", async () => {
    const h = await start();
    await postGithub(h);
    await vi.waitFor(() => expect(h.replyFetch).toHaveBeenCalled());
    const [url, init] = h.replyFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://ci-bridge.tools.svc/results");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ trigger: "github-review", sessionId: "github:acme/widgets#7", status: "succeeded", result: "Looks good." });
    const headers = init.headers as Record<string, string>;
    expect(headers["x-event-signature"]).toBe(`sha256=${hmacHex("callback-secret", body)}`);
    expect(init.redirect).toBe("manual");
  });

  it("failure: result comment explains, http reply says failed, and the label still comes off", async () => {
    const h = await start();
    h.poll.mockResolvedValueOnce({ status: "failed", error: "agent crashed" });
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalledWith("acme", "widgets", 7, "ai-review"));
    expect(h.postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Something went wrong processing this: agent crashed");
    const body = JSON.parse((h.replyFetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(body).toEqual({ trigger: "github-review", sessionId: "github:acme/widgets#7", status: "failed", error: "agent crashed" });
  });

  it("does not send an http reply whose signing secret is unavailable", async () => {
    const { "callback/secret": _omit, ...rest } = SECRETS;
    const h = await start({}, rest);
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    expect(h.replyFetch).not.toHaveBeenCalled();
    expect(h.logs.join("\n")).toMatch(/reply.http not sent \(signing secret callback\/secret unavailable\)/);
  });

  it("only declared effects run: no ack, no result, no label when reply.github is absent", async () => {
    const h = await start();
    h.submitEvent.mockResolvedValueOnce({ kind: "accepted", id: "inv-2", trigger: { name: "t", sessionId: "event:ci:x", reply: null } });
    await postGithub(h);
    await vi.waitFor(() => expect(h.poll).toHaveBeenCalled());
    await settle();
    expect(h.postIssueComment).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.removeIssueLabel).not.toHaveBeenCalled();
    expect(h.replyFetch).not.toHaveBeenCalled();
  });

  it("keeps the pending record when label removal fails, so the reconciler heals it", async () => {
    const h = await start();
    h.removeIssueLabel.mockRejectedValueOnce(new Error("502 after retries"));
    await postGithub(h);
    await vi.waitFor(() => expect(h.onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({ message: "502 after retries" })));
    expect(h.clear).not.toHaveBeenCalled();
    expect(await h.pendingLabelStore.list()).toHaveLength(1);
    // The run's own outcome was still reported.
    expect(h.postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Looks good.");
  });

  it("still polls, reports and removes the label when the ack comment fails", async () => {
    const h = await start();
    h.postIssueComment.mockRejectedValueOnce(new Error("github down"));
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    expect(h.poll).toHaveBeenCalled();
    expect(h.replyFetch).toHaveBeenCalled();
  });

  it("posts the Remote Control link at most once to the trigger's issue", async () => {
    const h = await start();
    h.poll.mockImplementationOnce(async (_id: string, hooks?: PollHooks) => {
      await hooks?.onRemoteControlUrl?.("https://claude.ai/code/session_abc");
      await hooks?.onRemoteControlUrl?.("https://claude.ai/code/session_abc");
      return { status: "succeeded", result: "Done." };
    });
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    const rc = h.postIssueComment.mock.calls.filter((c) => String(c[3]).includes("Watch live"));
    expect(rc).toEqual([["acme", "widgets", 7, "🤖 Watch live or take over the session here: https://claude.ai/code/session_abc"]]);
  });
});

describe("identity-link auto-resume on the event path", () => {
  const pending: OrchestratorInvokeResult = {
    status: "succeeded",
    identityLinkPending: true,
    identityLink: { provider: "claude", subject: "client-integration-gateway" },
    result: "To continue, please [link your Claude account](https://gateway.example.com/claude-auth/abc).",
  };

  it("posts the link prompt, waits, re-submits the same event and reports the resumed result (ack not repeated)", async () => {
    const waitForCompletion = vi.fn().mockResolvedValue({ token: "t", createdAt: "x" });
    const h = await start({
      claudeAuthStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), waitForCompletion } as unknown as ClaudeTokenStore,
      resumeWaitMs: 20_000,
    });
    h.poll.mockResolvedValueOnce(pending);
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    expect(waitForCompletion).toHaveBeenCalledWith("client-integration-gateway", 20_000, "setup-token");
    expect(h.submitEvent).toHaveBeenCalledTimes(2);
    expect(submittedEnvelope(h, 1)).toEqual(submittedEnvelope(h, 0));
    expect(h.order.filter((o) => o.startsWith("comment:"))).toEqual([
      "comment:Starting a review…",
      "comment:To continue, please [link your Claude account](https://gateway.example.com/claude-auth/abc).",
      "comment:Looks good.",
    ]);
  });

  it("leaves the prompt standing and reports failure over http when the link never completes", async () => {
    const waitForCompletion = vi.fn().mockResolvedValue(undefined);
    const h = await start({
      claudeAuthStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), waitForCompletion } as unknown as ClaudeTokenStore,
    });
    h.poll.mockResolvedValueOnce(pending);
    await postGithub(h);
    await vi.waitFor(() => expect(h.removeIssueLabel).toHaveBeenCalled());
    expect(h.submitEvent).toHaveBeenCalledTimes(1);
    const body = JSON.parse((h.replyFetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string);
    expect(body.status).toBe("failed");
  });
});

describe("POST /events/:source/tick (cron)", () => {
  const tick = (h: Harness, name: string, auth?: string, body = '{"repo":"evil/evil"}'): Promise<Response> =>
    fetch(`http://localhost:${h.port}/events/${name}/tick`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body,
    });

  it("401s a missing, malformed or unknown token, before revealing whether the source exists", async () => {
    const h = await start();
    expect((await tick(h, "nightly")).status).toBe(401);
    expect((await tick(h, "nightly", "Bearer wrong")).status).toBe(401);
    expect((await tick(h, "nightly", "Bearer aaa.unknown.sig")).status).toBe(401);
    expect((await tick(h, "does-not-exist", "Bearer aaa.unknown.sig")).status).toBe(401);
    expect((await tick(h, "nightly", NIGHTLY_TOKEN)).status).toBe(401);
    await settle();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("401s a valid ServiceAccount that is not THIS source's (another source, another namespace)", async () => {
    const h = await start();
    expect((await tick(h, "nightly", `Bearer ${OTHER_TOKEN}`)).status).toBe(401);
    expect((await tick(h, "nightly", "Bearer aaa.wrongns.sig")).status).toBe(401);
    await settle();
    expect(h.submitEvent).not.toHaveBeenCalled();
  });

  it("401s every tick when no authenticator or namespace is configured (fail closed)", async () => {
    const h = await start({ tickAuthenticator: undefined });
    expect((await tick(h, "nightly", `Bearer ${NIGHTLY_TOKEN}`)).status).toBe(401);
    await h.server.close();
    const h2 = await start({ tickNamespace: undefined });
    expect((await tick(h2, "nightly", `Bearer ${NIGHTLY_TOKEN}`)).status).toBe(401);
  });

  it("never sends a malformed bearer or source name to the TokenReview API", async () => {
    const authenticate = vi.fn(async () => undefined);
    const h = await start({ tickAuthenticator: { authenticate } });
    await tick(h, "nightly", "Bearer not-a-jwt");
    await tick(h, "nightly", "Basic aaa.nightly.sig");
    await tick(h, "Bad_Name", `Bearer ${NIGHTLY_TOKEN}`);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("404s an authenticated tick for a webhook or unknown source", async () => {
    const h = await start();
    expect((await tick(h, "github", "Bearer aaa.github.sig")).status).toBe(404);
    expect((await tick(h, "other", `Bearer ${OTHER_TOKEN}`)).status).toBe(404);
  });

  it("202s and relays a cron envelope whose body is the CR's payload (never the tick's)", async () => {
    const h = await start();
    expect((await tick(h, "nightly", `Bearer ${NIGHTLY_TOKEN}`)).status).toBe(202);
    await vi.waitFor(() => expect(h.submitEvent).toHaveBeenCalled());
    const envelope = submittedEnvelope(h);
    expect(envelope).toMatchObject({ source: "nightly", kind: "cron", headers: {}, body: { repo: "acme/widgets", n: 3 }, sender: {}, repository: "" });
    expect(envelope.id).toMatch(/^nightly-\d+$/);
    expect(h.submitEvent.mock.calls[0]?.[1]).toBeUndefined();
  });
});

describe("session pages", () => {
  it("relays a follow-up prompt as a conversational turn on the same session and posts to the STORED issue", async () => {
    const h = await start();
    // A session id that encodes no GitHub address at all: the issue must come
    // from the entry, not be parsed out of the id.
    const entry = await h.sessionPageStore.getOrCreate("event:ci:abc", { owner: "acme", repo: "widgets", issueNumber: 7 });
    const res = await fetch(`http://localhost:${h.port}/sessions/${entry.token}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "actually, target develop" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sessions/${entry.token}`);
    await vi.waitFor(() => expect(h.postIssueComment).toHaveBeenCalled());
    expect(h.invoke).toHaveBeenCalledWith("actually, target develop", "event:ci:abc", "device");
    expect(h.submitEvent).not.toHaveBeenCalled();
    expect(h.postIssueComment).toHaveBeenCalledWith("acme", "widgets", 7, "Follow-up done.");
    const updated = await h.sessionPageStore.getByToken(entry.token);
    expect(updated?.turns[0]).toMatchObject({ status: "succeeded", result: "Follow-up done." });
  });

  it("serves the rendered page for a valid token and 404s an unknown one", async () => {
    const h = await start();
    const entry = await h.sessionPageStore.getOrCreate("s1", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await h.sessionPageStore.addTurn(entry.sessionId, "do the thing");
    const res = await fetch(`http://localhost:${h.port}/sessions/${entry.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("acme/widgets #7");
    expect(html).toContain("do the thing");
    expect((await fetch(`http://localhost:${h.port}/sessions/does-not-exist`)).status).toBe(404);
  });
});

describe("live session tunnel (ADR 0026)", () => {
  async function startLive(): Promise<{ h: Harness; checkLive: ReturnType<typeof vi.fn>; openEventStream: ReturnType<typeof vi.fn>; forwardOpencode: ReturnType<typeof vi.fn> }> {
    const checkLive = vi.fn();
    const openEventStream = vi.fn();
    const forwardOpencode = vi.fn();
    const h = await start({
      orchestratorClient: { checkLive, openEventStream, forwardOpencode } as unknown as OrchestratorClient,
    });
    return { h, checkLive, openEventStream, forwardOpencode };
  }

  it("renders the live badge and caches the discovered agentRunId when checkLive reports live", async () => {
    const { h, checkLive } = await startLive();
    const entry = await h.sessionPageStore.getOrCreate("s1", { owner: "acme", repo: "widgets", issueNumber: 7 });
    checkLive.mockResolvedValue({ live: true, agentRunId: "run-42" });
    const html = await (await fetch(`http://localhost:${h.port}/sessions/${entry.token}`)).text();
    expect(html).toContain("LIVE");
    expect(html).toContain(`action="/sessions/${entry.token}/live-prompt"`);
    expect((await h.sessionPageStore.getByToken(entry.token))?.live).toEqual({ agentRunId: "run-42" });
  });

  it("clears cached live info once checkLive stops reporting live", async () => {
    const { h, checkLive } = await startLive();
    const entry = await h.sessionPageStore.getOrCreate("s1", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await h.sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    checkLive.mockResolvedValue({ live: false });
    expect(await (await fetch(`http://localhost:${h.port}/sessions/${entry.token}`)).text()).not.toContain("LIVE");
    expect((await h.sessionPageStore.getByToken(entry.token))?.live).toBeUndefined();
  });

  it("proxies the live event stream, and 404s it when not live", async () => {
    const { h, openEventStream } = await startLive();
    const entry = await h.sessionPageStore.getOrCreate("s1", { owner: "acme", repo: "widgets", issueNumber: 7 });
    expect((await fetch(`http://localhost:${h.port}/sessions/${entry.token}/live-events`)).status).toBe(404);
    await h.sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    openEventStream.mockResolvedValue(
      new Response(new TextEncoder().encode('data: {"type":"x"}\n\n'), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const res = await fetch(`http://localhost:${h.port}/sessions/${entry.token}/live-events`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: {"type":"x"}\n\n');
    expect(openEventStream).toHaveBeenCalledWith("run-42", "s1");
  });

  it("discovers and caches the opencode session id on first live prompt", async () => {
    const { h, forwardOpencode } = await startLive();
    const entry = await h.sessionPageStore.getOrCreate("s1", { owner: "acme", repo: "widgets", issueNumber: 7 });
    await h.sessionPageStore.setLive(entry.sessionId, { agentRunId: "run-42" });
    forwardOpencode.mockImplementation((_r: string, _s: string, req: { path: string }) =>
      Promise.resolve(req.path === "/session" ? { status: 200, body: [{ id: "ses_abc123" }] } : { status: 204 }),
    );
    const res = await fetch(`http://localhost:${h.port}/sessions/${entry.token}/live-prompt`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "also fix the tests" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    await vi.waitFor(() => expect(forwardOpencode).toHaveBeenCalledTimes(2));
    expect(forwardOpencode).toHaveBeenNthCalledWith(2, "run-42", "s1", {
      method: "POST",
      path: "/session/ses_abc123/prompt_async",
      body: { parts: [{ type: "text", text: "also fix the tests" }] },
    });
    expect((await h.sessionPageStore.getByToken(entry.token))?.live).toEqual({ agentRunId: "run-42", opencodeSessionId: "ses_abc123" });
  });
});
