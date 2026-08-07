package workflows

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/controller-agent/temporal-engine/internal/catalog"
)

// TestAgentWorkflowNameFor pins agentWorkflowNameFor's routing contract: a
// regression here (e.g. an accidental case reorder, or a chart authoring gap
// clearing an annotation) previously misrouted a pod-based coding agent into
// the declarative planner loop, which then tried to call a native CLI command
// ("gh") as a declarative Tool and got refused with "tool not available to
// this agent" -- see the claude-code-swe-agent/opencode-swe-agent incident
// this test was added for.
func TestAgentWorkflowNameFor(t *testing.T) {
	t.Run("bridged annotation routes to BridgedAgentWorkflow", func(t *testing.T) {
		name := agentWorkflowNameFor(catalog.AgentDescriptor{ID: "claude-code-swe-agent", Bridged: true})
		require.Equal(t, BridgedAgentWorkflowName, name)
	})

	t.Run("step-tool annotation routes to PodAgentWorkflow and wins over bridged", func(t *testing.T) {
		name := agentWorkflowNameFor(catalog.AgentDescriptor{ID: "x", StepToolRef: "some-tool", Bridged: true})
		require.Equal(t, PodAgentWorkflowName, name)
	})

	t.Run("neither annotation falls back to the declarative AgentWorkflow", func(t *testing.T) {
		name := agentWorkflowNameFor(catalog.AgentDescriptor{ID: "x"})
		require.Equal(t, AgentWorkflowName, name)
	})
}

// TestPodAgentsRouteBridged decodes Agent CRs shaped exactly like what
// charts/community-components/templates/agent-claude-code-swe.yaml and
// agent-opencode-swe.yaml render (name + the durable-agents.dev/bridged
// annotation, ADR 0028) and asserts they resolve to BridgedAgentWorkflow, not
// the declarative loop.
//
// This does not render the real Helm templates (that would need a `helm`
// binary, unavailable in this module's CI job) -- e2e/specs coverage owns
// asserting the LIVE deployed CR objects actually carry the annotation. This
// test instead pins the contract those two chart entries must keep meeting:
// a pod-based coding agent (image-driven, no toolRefs, an agentPrompt telling
// the model to invoke its CLI's own bash/gh/git directly) MUST declare
// `durable-agents.dev/bridged: "true"`, or its planner gets no `tools` and any
// CLI invocation the model narrates gets misread as a declarative tool call.
func TestPodAgentsRouteBridged(t *testing.T) {
	for _, agentID := range []string{"claude-code-swe-agent", "opencode-swe-agent"} {
		t.Run(agentID, func(t *testing.T) {
			obj := &unstructured.Unstructured{Object: map[string]any{
				"apiVersion": "core.controller-agent.dev/v1alpha1",
				"kind":       "Agent",
				"metadata": map[string]any{
					"name": agentID,
					"annotations": map[string]any{
						"durable-agents.dev/bridged": "true",
					},
				},
				"spec": map[string]any{
					"description":  "Performs software-engineering work on GitHub end-to-end.",
					"allowedRoles": []any{"writer"},
					// No toolRefs: a bridged pod agent's tools are its CLI's own
					// native built-ins, never declarative Tool CRs.
				},
			}}

			descriptor, err := catalog.DecodeAgent(obj)
			require.NoError(t, err)
			require.True(t, descriptor.Bridged, "expected %s to decode with Bridged=true", agentID)
			require.Empty(t, descriptor.ToolRefs)
			require.Equal(t, BridgedAgentWorkflowName, agentWorkflowNameFor(descriptor))
		})
	}
}
