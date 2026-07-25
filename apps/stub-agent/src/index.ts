import { runAgent } from "@controller-agent/agent-runtime";
import { buildReply, observedCredentialEnv } from "./reply.js";

/**
 * stub-agent — an Agent that speaks the real NATS protocol and makes no model
 * call.
 *
 * Everything between a GitHub webhook and a comment on the issue is real when
 * this runs: routing, RBAC, the authorization pre-flight, AgentRun creation,
 * secretEnv injection, the Job's security context, the NATS reply, and the
 * gateway's relay of that reply back to GitHub. The only thing replaced is the
 * part that cannot be hermetic — the model turn, which needs a paid Anthropic
 * credential and returns something different every time.
 *
 * It exists because that made the happy-path e2e spec impossible to run: a real
 * `claude-code-swe-agent` run never reaches a terminal phase in a cluster with
 * no credential, so the spec was skipped and the whole chain went unasserted.
 *
 * NOT for any non-e2e deployment. It is enabled only by
 * charts/community-components/values-e2e.yaml.
 */
await runAgent(async (session) => {
  await session.progress("stub-agent received the goal", { stage: "start", pct: 10 });

  // Credential env var NAMES that arrived, never values -- this string is
  // posted verbatim to a GitHub issue comment by the gateway's relay, so a
  // value here would be published. Names are the useful part anyway: they are
  // what proves the orchestrator's secretEnv injection reached the container,
  // which is otherwise only observable on the Job spec.
  const observed = observedCredentialEnv(process.env);
  await session.progress(`credential env present: ${observed.join(", ") || "(none)"}`, { stage: "inspect", pct: 60 });

  return buildReply(session.goal, observed);
});
