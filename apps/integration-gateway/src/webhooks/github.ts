import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookAuthError extends Error {}

/**
 * Verifies GitHub's `X-Hub-Signature-256: sha256=<hmac>` header (HMAC-SHA256
 * over the *raw* request body, using the shared webhook secret). Timing-safe
 * comparison, same posture as `CallbackSink`'s HMAC check
 * (docs/messaging.md) -- an unverified/malformed signature is rejected
 * outright, before the body is ever parsed as JSON.
 */
export function verifyGithubSignature(rawBody: string, signatureHeader: string | undefined, secret: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = signatureHeader ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new WebhookAuthError("GitHub webhook signature mismatch");
  }
}

export type GithubIssueEvent =
  | {
      kind: "issue-opened";
      owner: string;
      repo: string;
      issueNumber: number;
      senderLogin: string;
      senderIsBot: boolean;
      title: string;
      body: string;
      /**
       * Labels already attached at creation time -- GitHub fires a
       * SEPARATE `issues.labeled` webhook delivery (one per label) for an
       * issue created with labels already set, a second or two after
       * `opened`. Lets the caller skip relaying `opened` when the trigger
       * label is already here, so the guaranteed-to-follow `labeled`
       * event is the only one that dispatches (see server.ts) -- without
       * this, both events independently delegate to the same agent for
       * the same session, racing each other into two AgentRuns.
       */
      labelNames: string[];
    }
  | {
      kind: "issue-comment-created";
      owner: string;
      repo: string;
      issueNumber: number;
      senderLogin: string;
      senderIsBot: boolean;
      commentBody: string;
    }
  | {
      kind: "issue-labeled";
      owner: string;
      repo: string;
      issueNumber: number;
      senderLogin: string;
      senderIsBot: boolean;
      title: string;
      body: string;
      labelName: string;
    }
  | {
      /**
       * A label was applied to a pull request. Mirrors `issue-labeled` but
       * for the `pull_request` webhook event: the number lives under
       * `pull_request.number`, not `issue.number` (a PR is not delivered as
       * an `issues` event). Used to trigger an automated PR review when the
       * configured review label is applied (see server.ts). PRs and issues
       * share a single per-repo number space, so `prNumber` never collides
       * with an `issueNumber` for session-id purposes.
       */
      kind: "pull-request-labeled";
      owner: string;
      repo: string;
      prNumber: number;
      senderLogin: string;
      senderIsBot: boolean;
      title: string;
      body: string;
      labelName: string;
    }
  | { kind: "ignored" };

interface RepoPayload {
  owner: { login: string };
  name: string;
}

interface SenderPayload {
  login: string;
  type: string;
}

interface LabelPayload {
  name: string;
}

/**
 * Parses a verified GitHub `issues`/`issue_comment`/`pull_request` webhook
 * payload into a minimal normalized shape. Any event shape this gateway
 * doesn't act on (other actions, other event types) maps to
 * `{ kind: "ignored" }` rather than throwing -- GitHub sends far more event
 * types/actions than this adapter cares about, and an unrecognized payload is
 * not an error.
 */
export function parseGithubEvent(eventName: string | undefined, rawBody: string): GithubIssueEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: "ignored" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignored" };
  const payload = parsed as {
    action?: unknown;
    repository?: RepoPayload;
    sender?: SenderPayload;
    issue?: { number?: unknown; title?: unknown; body?: unknown; labels?: LabelPayload[] };
    pull_request?: { number?: unknown; title?: unknown; body?: unknown };
    comment?: { body?: unknown };
    label?: LabelPayload;
  };

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const sender = payload.sender;
  if (!owner || !repo || !sender) return { kind: "ignored" };

  const senderLogin = sender.login;
  const senderIsBot = sender.type === "Bot";

  // A `pull_request` event carries its number under `pull_request.number`,
  // not `issue.number` -- handled before the `issueNumber` guard below (which
  // gates only the `issues`/`issue_comment` branches).
  if (eventName === "pull_request" && payload.action === "labeled") {
    const prNumber = payload.pull_request?.number;
    if (typeof prNumber !== "number") return { kind: "ignored" };
    const labelName = payload.label?.name;
    if (!labelName) return { kind: "ignored" };
    const title = typeof payload.pull_request?.title === "string" ? payload.pull_request.title : "";
    const body = typeof payload.pull_request?.body === "string" ? payload.pull_request.body : "";
    return { kind: "pull-request-labeled", owner, repo, prNumber, senderLogin, senderIsBot, title, body, labelName };
  }

  const issueNumber = payload.issue?.number;
  if (typeof issueNumber !== "number") return { kind: "ignored" };

  if (eventName === "issues" && payload.action === "opened") {
    const title = typeof payload.issue?.title === "string" ? payload.issue.title : "";
    const body = typeof payload.issue?.body === "string" ? payload.issue.body : "";
    const labelNames = (payload.issue?.labels ?? []).map((label) => label.name).filter((name) => typeof name === "string");
    return { kind: "issue-opened", owner, repo, issueNumber, senderLogin, senderIsBot, title, body, labelNames };
  }

  if (eventName === "issue_comment" && payload.action === "created") {
    const commentBody = typeof payload.comment?.body === "string" ? payload.comment.body : "";
    return { kind: "issue-comment-created", owner, repo, issueNumber, senderLogin, senderIsBot, commentBody };
  }

  if (eventName === "issues" && payload.action === "labeled") {
    const labelName = payload.label?.name;
    if (!labelName) return { kind: "ignored" };
    const title = typeof payload.issue?.title === "string" ? payload.issue.title : "";
    const body = typeof payload.issue?.body === "string" ? payload.issue.body : "";
    return { kind: "issue-labeled", owner, repo, issueNumber, senderLogin, senderIsBot, title, body, labelName };
  }

  return { kind: "ignored" };
}
