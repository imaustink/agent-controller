import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunsSince, cleanupAgentRunsSince, waitFor } from "../support/k8s.js";
import { withPortForward } from "../support/k8s.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";

/**
 * `support/k8s.ts`'s own `withPortForward` gates readiness on a plain HTTP
 * `fetch()`, which is the right probe for every OTHER service this suite
 * forwards to but wrong for `temporal-dev-server:7233` -- Temporal's frontend
 * speaks raw gRPC/HTTP2, which never answers an HTTP/1.1 GET, so that probe
 * timed out on every attempt for the full 30s window regardless of whether
 * the forward was actually up (confirmed: the identical forward worked fine
 * against the `temporal` CLI the whole time this was "failing"). A bare TCP
 * connect is the correct readiness signal for a gRPC port.
 */
async function withTemporalPortForward<T>(localPort: number, body: () => Promise<T>): Promise<T> {
  requireMinikubeContext();
  const child = execFile("kubectl", ["-n", "controller-agent", "port-forward", "svc/temporal-dev-server", `${localPort}:7233`]);
  let exited: string | undefined;
  child.on("exit", (code, signal) => {
    exited = `kubectl port-forward svc/temporal-dev-server exited (code ${code ?? "null"}, signal ${signal ?? "null"})`;
  });
  try {
    await waitFor(
      "port-forward to temporal-dev-server:7233 to accept connections",
      () =>
        new Promise<true | undefined>((resolve) => {
          const socket = connect({ host: "127.0.0.1", port: localPort, timeout: 1_000 });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(undefined));
          socket.once("timeout", () => {
            socket.destroy();
            resolve(undefined);
          });
        }),
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    return await body();
  } finally {
    if (!exited) child.kill();
  }
}

/**
 * Proves the Temporal engine (docs/adr/0036) actually routes a bridged pod
 * agent (`claude-code-swe-agent`, `opencode-swe-agent`, and their e2e stand-in
 * `stub-agent`) through `BridgedAgentWorkflow` -- not the declarative
 * `AgentWorkflow` those agents were silently falling back to.
 *
 * That fallback was a real, reproduced production bug: `stub-agent`/
 * `claude-code-swe-agent` missing the `durable-agents.dev/bridged` chart
 * annotation left `agentWorkflowNameFor` (engines/temporal/internal/temporal/
 * workflows/agent_workflow.go) defaulting to the declarative loop, which has
 * no real tools at all -- the planner then guessed at tool names ("gh",
 * "gh_repo_clone", "call_tool") and every guess was refused. The annotation
 * fix alone is necessary but not sufficient: getting a REAL bridged episode to
 * run end-to-end on this suite's minikube profile also needed a dev-mode
 * Temporal server (none is bundled -- e2e/manifests/temporal-dev-server.yaml)
 * and several engine-config wires that had no default in a hermetic profile
 * (temporal-engine.nats.url, .qdrant.host, .gateway.identity.defaultSubject/
 * defaultRoles, .identityLink.gatewayUrl -- all in values-e2e.yaml), plus a
 * code fix for a claude-remote credential response-shape mismatch
 * (engines/temporal/internal/identitylink/identitylink.go) and a Job-name
 * double-prefix bug that broke Job creation for ANY AgentRun this engine
 * launches (controllers/core-controller/internal/controller/
 * agentrun_controller.go).
 *
 * This spec is the actual proof point for all of that: it drives the same
 * webhook path `happy-path.e2e.ts` does, then asks Temporal itself (not a log
 * line, not an inferred side effect) whether a `BridgedAgentWorkflow`
 * execution completed for this run.
 */

const execFileAsync = promisify(execFile);

requireMinikubeContext();

// 18090/18091/18092 belong to happy-path/resilience/identity-keying respectively.
const GATEWAY_PORT = 18093;
const TEMPORAL_PORT = 17234;
// Must be one of values-e2e.yaml's `integration-gateway.config.githubIdentities`
// entries -- an unlisted sender resolves no identity and the turn is dropped
// before it ever reaches the orchestrator, silently (no error, no AgentRun).
const SENDER = "e2e-other-user";
const OWNER = "e2e-bridged-org";
const REPO = "e2e-bridged-repo";
const STUB_REPLY_MARKER = "stub-agent-reply";

/**
 * Cross-entry-point providers (claude, claude-remote) key by PRINCIPAL, not
 * by `gateway.identity.defaultSubject` -- a webhook turn's signed sender
 * assertion resolves `principal = github:<senderLogin>` regardless of which
 * shared subject the tokenless internal hop itself defaults to (see
 * identity-keying.e2e.ts's CANONICAL, which this mirrors). This is the
 * subject a credential must be seeded under for the engine's identity-link
 * gate to resolve it.
 */
const CANONICAL = `github:${SENDER}`;

describe("Temporal engine: a bridged pod agent actually runs as BridgedAgentWorkflow", () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await webhookSecret();
    await resetFakeGithub();
    // Both providers stub-agent's Agent CR declares in this cluster (mirrors
    // claude-code-swe-agent's own identityProviders) -- see this suite's
    // credential-store.ts doc comment for why seeding is the only hermetic way
    // to get an authorized (not link-required) verdict.
    await seedAllClaudeCredentials(CANONICAL);
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  it("launches a real BridgedAgentWorkflow execution for the bridged agent an IntegrationRoute names", async () => {
    const startedAt = new Date();
    const issueNumber = Date.now() % 100000;

    const status = await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({
          owner: OWNER,
          repo: REPO,
          issueNumber,
          label: "ai-triage",
          senderLogin: SENDER,
        }),
        secret,
      );
      return res.status;
    });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);

    // External proof: the run reached a real pod, which posted the comment
    // back through the (fake) GitHub API -- same assertion happy-path.e2e.ts
    // makes, kept here so this spec stands on its own.
    const comment = await waitFor(
      "the stub agent's reply to be posted back to the issue",
      async () => {
        const posted = (await fakeGithubRequests()).filter(
          (r) => r.method === "POST" && r.path === `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
        );
        return posted.length > 0 ? posted[posted.length - 1] : undefined;
      },
      { timeoutMs: 420_000 },
    );
    expect(comment?.body).toContain(STUB_REPLY_MARKER);

    // Mechanism proof: Temporal itself, not a log line, says a
    // BridgedAgentWorkflow execution actually ran and completed for the
    // route's target Agent (`stub-agent`, per the `github-issue-labeled-
    // triage` IntegrationRoute this webhook matches) -- the only way that's
    // true is if `agentWorkflowNameFor` resolved the bridged branch,
    // LaunchAgentRun actually created the Job (which needed the
    // core-controller Job-name fix), and the pod ran to completion.
    const run = (await agentRunsSince(startedAt))[0];
    expect(run, "an AgentRun should have been created for the labeled issue").toBeTruthy();

    const completed = await withTemporalPortForward(TEMPORAL_PORT, async () => {
      return waitFor(
        "a completed BridgedAgentWorkflow execution for stub-agent",
        async () => {
          const { stdout } = await execFileAsync("temporal", [
            "workflow",
            "list",
            "--address",
            `localhost:${TEMPORAL_PORT}`,
            "--namespace",
            "default",
            "--query",
            `WorkflowType='BridgedAgentWorkflow' and ExecutionStatus='Completed'`,
            "-o",
            "json",
          ]);
          const executions = JSON.parse(stdout || "[]") as Array<{
            execution: { workflowId: string };
            startTime: string;
          }>;
          return executions.find(
            (e) => e.execution.workflowId.startsWith("agent-stub-agent-") && new Date(e.startTime) >= startedAt,
          );
        },
        { timeoutMs: 60_000 },
      );
    });
    expect(completed).toBeTruthy();
  });
});
