import { createHmac } from "node:crypto";

/**
 * Signs a payload the way GitHub does (`X-Hub-Signature-256`, HMAC-SHA256 over
 * the raw body) and posts it to the gateway's webhook route.
 *
 * The signature is computed over the EXACT bytes sent, not a re-serialization:
 * the gateway verifies against the raw body, so any difference in key order or
 * whitespace between what we sign and what we send fails verification in a way
 * that looks like a bug in the gateway rather than in the test.
 */
export async function postGithubWebhook(
  baseUrl: string,
  event: string,
  payload: unknown,
  secret: string,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `e2e-${Date.now()}`,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

/**
 * An `issues.labeled` payload carrying the trigger label — the real ai-triage
 * entry point.
 *
 * `sender.login` matters more than it looks: it is the only per-user
 * identifier a webhook-driven turn carries (the gateway authenticates to
 * `/invoke` with its own service token), so it is what the canonical
 * credential subject is derived from (ADR 0029). Tests vary it to prove two
 * different humans don't collapse onto one credential.
 */
export function issueLabeledPayload({
  owner,
  repo,
  issueNumber,
  label,
  senderLogin,
  title = "e2e: something is broken",
  body = "Steps to reproduce are in the description.",
}: {
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
  senderLogin: string;
  title?: string;
  body?: string;
}) {
  return {
    action: "labeled",
    label: { name: label },
    issue: { number: issueNumber, title, body, labels: [{ name: label }] },
    repository: { name: repo, owner: { login: owner }, full_name: `${owner}/${repo}` },
    sender: { login: senderLogin, type: "User" },
  };
}

/**
 * Fires the same labeled-issue trigger twice, with a pause between.
 *
 * One trigger is not enough to reach the Claude providers, and that is a
 * property of the system rather than of the test. A webhook turn is
 * fire-and-forget (no live channel), so when the identity gate finds an
 * unlinked provider it starts the link, PARKS a pendingIdentityLink, and ends
 * the turn -- it does not block waiting. With `github` declared first
 * (ADR 0029), the first trigger therefore always stops at github.
 *
 * The second trigger re-enters via checkPendingIdentityLink, which polls the
 * now-completable device flow, stores the github link, and resumes into
 * delegation -- which is where `claude`/`claude-remote` finally resolve and a
 * credential subject gets keyed.
 */
export async function triggerTwice(
  baseUrl: string,
  payload: unknown,
  secret: string,
  pauseMs = 20_000,
): Promise<void> {
  await postGithubWebhook(baseUrl, "issues", payload, secret);
  await new Promise((r) => setTimeout(r, pauseMs));
  await postGithubWebhook(baseUrl, "issues", payload, secret);
}
