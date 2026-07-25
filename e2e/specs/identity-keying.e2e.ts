import { beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { waitFor, withPortForward } from "../support/k8s.js";
import { claudeCredentialSubjects, deleteCredentialKeys } from "../support/redis.js";
import { issueLabeledPayload, triggerTwice } from "../support/webhook.js";
import { resetFakeGithub, webhookSecret } from "../support/fixtures.js";

requireMinikubeContext();

const GATEWAY_PORT = 18092;
const SENDER = "e2e-user";

/**
 * The regression this suite was created for.
 *
 * A human authorized Claude during ai-triage, went to chat, and was asked to
 * authorize again — because `ClaudeTokenStore` keys by `identity.subject`, and
 * the webhook path (a shared OIDC service subject) and the chat path
 * (`openwebui:<id>`) resolve different ones. ADR 0029 made both converge on a
 * canonical `github:<login>`.
 *
 * No unit test can see this: the split only exists once two different
 * *processes* authenticate to `/invoke` two different ways. That is the whole
 * argument for these tests.
 */
describe("credential keying converges across entry points (ADR 0029)", () => {
  let secret: string;

  beforeAll(async () => {
    secret = await webhookSecret();
    await resetFakeGithub();
    // Start from a known-unlinked state so an assertion about "which subject
    // did this turn write" isn't satisfied by a record left behind earlier.
    await deleteCredentialKeys("claudeAuth:*");
    await deleteCredentialKeys("claudeAuthLogin:*");
  });

  it("keys a webhook-triggered turn's Claude credential under github:<senderLogin>, never the shared service subject", async () => {
    await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) =>
      triggerTwice(
        baseUrl,
        issueLabeledPayload({
          owner: "e2e-org",
          repo: "e2e-repo",
          issueNumber: 4242,
          label: "ai-triage",
          senderLogin: SENDER,
        }),
        secret,
      ),
    );

    // The turn will PROMPT for authorization (nothing is linked). We are not
    // asserting the prompt — we're asserting the subject the pending flow is
    // keyed on, which is what the resume later waits against.
    const subjects = await waitFor(
      "a Claude credential flow to be keyed for the webhook sender",
      async () => {
        const found = await claudeCredentialSubjects("setup-token");
        return found.length > 0 ? found : undefined;
      },
      { timeoutMs: 120_000 },
    );

    expect(subjects).toContain(`github:${SENDER}`);

    // The specific failure being prevented: a credential written under the
    // gateway's shared service identity, which every other human's webhook
    // turn would then silently reuse.
    expect(subjects.some((s) => s.startsWith("client-") || s === "openwebui")).toBe(false);
  });

  it("does not collapse two different senders onto one credential subject", async () => {
    await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) =>
      triggerTwice(
        baseUrl,
        issueLabeledPayload({
          owner: "e2e-org",
          repo: "e2e-repo",
          issueNumber: 4243,
          label: "ai-triage",
          senderLogin: "e2e-other-user",
        }),
        secret,
      ),
    );

    const subjects = await waitFor(
      "a second, distinct credential subject",
      async () => {
        const found = await claudeCredentialSubjects("setup-token");
        return found.length > 1 ? found : undefined;
      },
      { timeoutMs: 120_000 },
    );

    // Two humans, two subjects. Sharing here would be the shared-identity
    // vulnerability that `OpenWebUiForwardedUserResolver` was written to fix,
    // reintroduced on the webhook side.
    expect(new Set(subjects).size).toBeGreaterThan(1);
    expect(subjects).toContain("github:e2e-other-user");
  });

  it("lower-cases the login so webhook casing and OAuth casing share one key", async () => {
    await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) =>
      triggerTwice(
        baseUrl,
        issueLabeledPayload({
          owner: "e2e-org",
          repo: "e2e-repo",
          issueNumber: 4244,
          label: "ai-triage",
          // GitHub echoes a login's original casing in webhooks but
          // normalizes it in the OAuth user API. Two casings would key two
          // records and re-prompt exactly the way this all started.
          senderLogin: "E2E-User",
        }),
        secret,
      ),
    );

    const subjects = await waitFor(
      "the mixed-case sender's credential subject",
      async () => {
        const found = await claudeCredentialSubjects("setup-token");
        return found.length > 0 ? found : undefined;
      },
      { timeoutMs: 120_000 },
    );

    expect(subjects).toContain("github:e2e-user");
    expect(subjects).not.toContain("github:E2E-User");
  });
});
