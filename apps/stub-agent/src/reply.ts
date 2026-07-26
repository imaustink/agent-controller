/**
 * The canned reply, kept out of index.ts so it is unit-testable without a NATS
 * connection.
 */

/**
 * Marker every stub reply carries.
 *
 * The happy-path spec matches on this rather than on prose: it has to
 * distinguish "the stub replied and the gateway relayed it" from "some comment
 * appeared", and asserting on a sentence invites a spec that breaks when the
 * wording is reworded.
 */
export const STUB_REPLY_MARKER = "stub-agent-reply";

/**
 * Env vars the authorization pre-flight injects as `secretEnv`, in the order
 * reported. Deliberately a fixed list rather than "every var that looks like a
 * credential": a prefix heuristic over `process.env` would report whatever the
 * base image happens to set, and could match a real secret the list never meant
 * to name.
 *
 * Kept in sync by hand with `PROVIDER_ENV_VAR` and `ACTOR_LOGIN_ENV` in
 * apps/agent-orchestrator/src/agent/graph.ts. A name that drifts shows up as a
 * missing entry in the reply, not as a silent pass.
 */
export const CREDENTIAL_ENV_NAMES = [
  "AGENT_ACTOR_LOGIN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_LOGIN_CREDENTIALS_JSON",
  "GITHUB_TOKEN",
] as const;

/**
 * NAMES of the credential env vars that are present and non-empty. Never
 * values: the caller publishes this to a GitHub issue comment.
 */
export function observedCredentialEnv(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIAL_ENV_NAMES.filter((name) => (env[name] ?? "") !== "");
}

/**
 * The reply the orchestrator relays to the user (a GitHub issue comment, in the
 * triage flow).
 *
 * Echoes the goal so the spec can prove the goal survived the whole webhook ->
 * route -> orchestrator -> AgentRun -> Job -> NATS path intact, rather than
 * only that *something* replied. Truncated because a goal can carry an entire
 * issue body and a comment is not the place to mirror it back in full.
 */
export function buildReply(goal: string, observedEnv: string[]): string {
  const truncated = goal.length > 200 ? `${goal.slice(0, 200)}...` : goal;
  return [
    `${STUB_REPLY_MARKER}: no model was called.`,
    "",
    `goal: ${truncated}`,
    `credential env present: ${observedEnv.join(", ") || "(none)"}`,
  ].join("\n");
}
