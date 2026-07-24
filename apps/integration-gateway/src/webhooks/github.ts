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
 * Parses a verified GitHub `issues`/`pull_request` webhook payload into a
 * minimal normalized shape. Only an explicit label application
 * (`issues.labeled` / `pull_request.labeled`) is ever actionable -- unlabeled
 * events (`issues.opened`, `issue_comment.created`, any other action/event)
 * all map to `{ kind: "ignored" }` rather than throwing. GitHub sends far more
 * event types/actions than this adapter cares about, and an unrecognized
 * payload is not an error.
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

  // `issues.opened` and `issue_comment.created` are deliberately NOT
  // actionable: an unlabeled issue/comment must be a no-op. Only an explicit
  // `issues.labeled` (with the configured trigger label) dispatches anything
  // -- see server.ts.
  if (eventName === "issues" && payload.action === "labeled") {
    const labelName = payload.label?.name;
    if (!labelName) return { kind: "ignored" };
    const title = typeof payload.issue?.title === "string" ? payload.issue.title : "";
    const body = typeof payload.issue?.body === "string" ? payload.issue.body : "";
    return { kind: "issue-labeled", owner, repo, issueNumber, senderLogin, senderIsBot, title, body, labelName };
  }

  return { kind: "ignored" };
}
