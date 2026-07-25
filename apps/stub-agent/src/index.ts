import { runAgent } from "@controller-agent/agent-runtime";
import { buildReply, observedCredentialEnv } from "./reply.js";
import { isImmediate, readPacing } from "./pacing.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  // Optional pacing (resilience.e2e.ts). Absent these env vars the stub replies
  // immediately, exactly as before, so happy-path/identity-keying are unaffected.
  const pacing = readPacing(process.env);
  if (!isImmediate(pacing)) {
    const narrateUntil = Date.now() + pacing.narrateForMs;
    while (Date.now() < narrateUntil) {
      await sleep(Math.min(pacing.narrateEveryMs, Math.max(0, narrateUntil - Date.now())));
      await session.progress(`still working (${new Date().toISOString()})`, { stage: "work" });
    }
    if (pacing.silentForMs > 0) await sleep(pacing.silentForMs);
  }

  return buildReply(session.goal, observed);
});
