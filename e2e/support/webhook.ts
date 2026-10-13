import { createHmac, randomUUID } from "node:crypto";
import { fetchThrough, type PortForward } from "./k8s.js";

/**
 * Signs and posts events to integration-gateway's generic ingestion endpoints
 * (docs/event-triggers.md §7):
 *
 *   POST /webhooks/:source       verified per the EventSource's `verify.scheme`
 *   POST /events/:source/tick    Bearer <tick token>, cron sources only
 *
 * Every signer works on the EXACT bytes sent, never a re-serialization: the
 * gateway verifies the raw body before parsing, so any difference in key order or
 * whitespace between what is signed and what is sent fails verification in a way
 * that looks like a gateway bug rather than a test bug. That is why the posters
 * here take a body STRING (or serialize once and sign that string).
 *
 * The senders are us, but the verification is real: each scheme is the same
 * construction the corresponding third party (GitHub, Slack, a CI notifier) uses.
 */

// ── signers ──────────────────────────────────────────────────────────────────

/** `hex(hmac-sha256(secret, body))` -- GitHub's and the generic-hmac source's construction. */
export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Slack's v0 request signature: `v0=hex(hmac(secret, "v0:" + ts + ":" + body))`.
 * `timestamp` is unix SECONDS as a string, exactly what goes in
 * `x-slack-request-timestamp` -- the gateway rejects one older than 300s.
 */
export function slackV0Signature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

/** Unix seconds now, as Slack sends it. `offsetSeconds` < 0 ages it (stale-timestamp tests). */
export function slackTimestamp(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

// ── raw poster ───────────────────────────────────────────────────────────────

/** What a poster hands back: the status and the response text (Slack's challenge comes back here). */
export interface PostResult {
  status: number;
  text: string;
}

/**
 * POSTs `body` verbatim to `/webhooks/<source>` with `headers` (content-type
 * defaults to application/json). The lowest layer: every scheme-specific poster
 * below is this plus a signature header, and the verification specs use it
 * directly to send deliberately wrong signatures.
 */
export async function postWebhookRaw(
  forward: PortForward | { baseUrl: string },
  source: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<PostResult> {
  const res = await fetchThrough(forward, `/webhooks/${encodeURIComponent(source)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

// ── scheme-specific posters ──────────────────────────────────────────────────

/**
 * An `hmacSha256` source: `<header>: <prefix><hex hmac(secret, body)>`.
 * Defaults match the chart's `generic-hmac` example (x-signature-256, "sha256=").
 */
export async function postHmacWebhook(
  forward: PortForward | { baseUrl: string },
  source: string,
  payload: unknown,
  secret: string,
  opts: { header?: string; prefix?: string; headers?: Record<string, string> } = {},
): Promise<PostResult> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const header = opts.header ?? "x-signature-256";
  const prefix = opts.prefix ?? "sha256=";
  return postWebhookRaw(forward, source, body, { ...opts.headers, [header]: `${prefix}${hmacSha256Hex(secret, body)}` });
}

/**
 * A GitHub delivery to the `github` source: X-Hub-Signature-256 over the raw
 * body, plus the `x-github-event` header the example triggers' CEL keys on and a
 * unique `x-github-delivery` (the source's deliveryIdHeader -> envelope.id).
 */
export async function postGithubDelivery(
  forward: PortForward | { baseUrl: string },
  event: string,
  payload: unknown,
  secret: string,
  opts: { deliveryId?: string; source?: string } = {},
): Promise<PostResult> {
  return postHmacWebhook(forward, opts.source ?? "github", payload, secret, {
    header: "x-hub-signature-256",
    prefix: "sha256=",
    headers: {
      "x-github-event": event,
      "x-github-delivery": opts.deliveryId ?? `e2e-${randomUUID()}`,
    },
  });
}

/**
 * Back-compat wrapper with the pre-ADR-0048 signature (`baseUrl`, not a forward),
 * kept so the identity/resilience specs that only need "a labeled issue arrived"
 * did not have to change. Returns a Response-like `{status}`.
 */
export async function postGithubWebhook(
  baseUrl: string,
  event: string,
  payload: unknown,
  secret: string,
): Promise<{ status: number }> {
  const { status } = await postGithubDelivery({ baseUrl }, event, payload, secret);
  return { status };
}

/** A Slack Events API request to a `slackV0` source, signed with a fresh timestamp unless one is given. */
export async function postSlackEvent(
  forward: PortForward | { baseUrl: string },
  payload: unknown,
  signingSecret: string,
  opts: { source?: string; timestamp?: string; signature?: string } = {},
): Promise<PostResult> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = opts.timestamp ?? slackTimestamp();
  return postWebhookRaw(forward, opts.source ?? "slack", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": opts.signature ?? slackV0Signature(signingSecret, timestamp, body),
  });
}

/**
 * A `bearer` source. With the default header (`authorization`) the value is
 * `Bearer <token>`; with any other header the raw token is sent, per §1.
 */
export async function postBearerWebhook(
  forward: PortForward | { baseUrl: string },
  source: string,
  payload: unknown,
  token: string | undefined,
  opts: { header?: string } = {},
): Promise<PostResult> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const header = (opts.header ?? "authorization").toLowerCase();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers[header] = header === "authorization" ? `Bearer ${token}` : token;
  return postWebhookRaw(forward, source, body, headers);
}

/** `POST /events/<source>/tick` -- what a cron source's CronJob sends. `token` undefined sends no Authorization. */
export async function postTick(
  forward: PortForward | { baseUrl: string },
  source: string,
  token: string | undefined,
): Promise<PostResult> {
  const res = await fetchThrough(forward, `/events/${encodeURIComponent(source)}/tick`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, text: await res.text() };
}

// ── payload builders ─────────────────────────────────────────────────────────

/** The repository block every GitHub payload carries; `full_name` is what the `github` source's repositoryFrom reads. */
function githubRepository(owner: string, repo: string) {
  return { name: repo, owner: { login: owner }, full_name: `${owner}/${repo}` };
}

/** `sender` -- `type: "Bot"` is what the `github` source's isBotFrom (`body.sender.type == "Bot"`) drops. */
function githubSender(login: string, isBot = false) {
  return { login, type: isBot ? "Bot" : "User" };
}

/**
 * An `issues.labeled` payload -- the ai-triage / ai-review entry point.
 *
 * `sender.login` is the only per-user identifier a webhook-driven turn carries
 * (the gateway authenticates to `/invoke` with its own service token), so it is
 * what the canonical credential subject is derived from (ADR 0029). Tests vary
 * it to prove two different humans don't collapse onto one credential.
 */
export function issueLabeledPayload({
  owner,
  repo,
  issueNumber,
  label,
  senderLogin,
  senderIsBot = false,
  title = "e2e: something is broken",
  body = "Steps to reproduce are in the description.",
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
  senderLogin: string;
  senderIsBot?: boolean;
  title?: string;
  body?: string;
}) {
  return {
    action: "labeled",
    label: { name: label },
    issue: { number: issueNumber, title, body, labels: [{ name: label }] },
    repository: githubRepository(owner, repo),
    sender: githubSender(senderLogin, senderIsBot),
  };
}

/**
 * An `issues.opened` payload. Carries the trigger label in `issue.labels` on
 * purpose: an issue OPENED with ai-triage already applied must still not
 * trigger -- only the `labeled` action does, which is the property the example
 * triggers' CEL (`body.action == "labeled"`) pins.
 */
export function issueOpenedPayload({
  owner,
  repo,
  issueNumber,
  senderLogin,
  labels = [],
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  senderLogin: string;
  labels?: string[];
}) {
  return {
    action: "opened",
    issue: {
      number: issueNumber,
      title: "e2e: opened, not labeled",
      body: "An issue that arrives already labeled.",
      labels: labels.map((name) => ({ name })),
    },
    repository: githubRepository(owner, repo),
    sender: githubSender(senderLogin),
  };
}

/** A `pull_request` payload for `labeled` / `unlabeled` / `opened`. */
export function pullRequestPayload({
  action,
  owner,
  repo,
  number,
  label,
  senderLogin,
  title = "e2e: a pull request",
  body = "Changes under review.",
}: {
  action: "labeled" | "unlabeled" | "opened";
  owner: string;
  repo: string;
  number: number;
  label?: string;
  senderLogin: string;
  title?: string;
  body?: string;
}) {
  return {
    action,
    number,
    ...(label !== undefined ? { label: { name: label } } : {}),
    pull_request: {
      number,
      title,
      body,
      labels: label !== undefined && action !== "unlabeled" ? [{ name: label }] : [],
    },
    repository: githubRepository(owner, repo),
    sender: githubSender(senderLogin),
  };
}

/**
 * A Slack `event_callback` carrying an `app_mention` -- what the
 * slack-mention-chat example matches (`body.type == "event_callback" &&
 * body.event.type == "app_mention"`). `threadTs` omitted -> the trigger's
 * `thread` param falls back to `event.ts`.
 */
export function slackAppMentionPayload({
  text,
  channel,
  ts,
  threadTs,
  user = "U0E2EUSER",
}: {
  text: string;
  channel: string;
  ts: string;
  threadTs?: string;
  user?: string;
}) {
  return {
    token: "e2e-deprecated-verification-token",
    team_id: "T0E2E",
    api_app_id: "A0E2E",
    type: "event_callback",
    event_id: `Ev${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: "app_mention",
      user,
      text,
      ts,
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  };
}

/** Slack's Request-URL handshake: answered by the gateway with `challenge`, never relayed. */
export function slackUrlVerificationPayload(challenge: string) {
  return { token: "e2e-deprecated-verification-token", challenge, type: "url_verification" };
}

/** The CI notifier body the ci-failure-skill example documents. */
export function ciFailurePayload({
  repository,
  job,
  status = "failure",
  branch = "main",
  url = "https://ci.example.invalid/runs/1",
}: {
  repository: string;
  job: string;
  status?: string;
  branch?: string;
  url?: string;
}) {
  return { status, repository, branch, job, url };
}

/** The generic-hmac-tool example's body: `{url}`, which becomes the web-fetch tool's string input. */
export function genericUrlPayload(url: string, extra: Record<string, unknown> = {}) {
  return { url, ...extra };
}
