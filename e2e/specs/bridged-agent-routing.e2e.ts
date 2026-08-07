import { describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectlJson } from "../support/k8s.js";

requireMinikubeContext();

/**
 * The Temporal engine (docs/adr/0036) decides which workflow drives an Agent
 * purely from a CR annotation -- `durable-agents.dev/bridged: "true"` means
 * `BridgedAgentWorkflow` (an unmodified upstream pod/CLI agent, speaking the
 * real NATS protocol); its absence falls through to the declarative
 * `AgentWorkflow`, an LLM planner that only ever calls `Tool`s named in the
 * agent's own `toolRefs`.
 *
 * `claude-code-swe-agent` and `opencode-swe-agent` are pod-based coding
 * agents: their `agentPrompt` tells the model to invoke `git`/`gh` as plain
 * CLI commands, and neither declares any `toolRefs`. Deployed WITHOUT the
 * annotation, both silently fell through to the declarative loop, which
 * handed the planner that same prompt but an EMPTY tool list -- so it tried
 * to call "gh" as a declarative Tool and got refused with "tool not
 * available to this agent". That is a real incident this asserts against,
 * not a hypothetical: charts/community-components/templates/
 * agent-claude-code-swe.yaml and agent-opencode-swe.yaml never set the
 * annotation until this fix.
 *
 * This can't observe an actual `BridgedAgentWorkflow` execution end-to-end
 * (this minikube profile has no Temporal server deployed alongside the
 * engine), so it asserts the one thing that IS verifiable here and is
 * exactly what regressed: the live, cluster-deployed `Agent` CR objects
 * carry the annotation a Helm chart edit could silently drop again.
 * `stub-agent` is included because it stands in for claude-code-swe-agent in
 * happy-path.e2e.ts and must route identically to stay a faithful stand-in.
 */
describe("pod-based agents are annotated for BridgedAgentWorkflow routing", () => {
  const BRIDGED_ANNOTATION = "durable-agents.dev/bridged";

  // opencode-swe-agent is intentionally excluded here: it is disabled in this
  // suite's deployed values (no built image to enable it with), so no live CR
  // exists to assert against. Its routing contract is instead pinned
  // hermetically in engines/temporal/internal/temporal/workflows/
  // agent_workflow_routing_test.go (TestPodAgentsRouteBridged), alongside
  // claude-code-swe-agent.
  const BRIDGED_AGENTS = ["claude-code-swe-agent", "stub-agent"];

  it.each(BRIDGED_AGENTS)("Agent %s declares the bridged annotation", async (agentName) => {
    const agent = await kubectlJson<{ metadata?: { annotations?: Record<string, string> } }>([
      "get",
      "agent",
      agentName,
    ]);
    expect(agent.metadata?.annotations?.[BRIDGED_ANNOTATION]).toBe("true");
  });
});
