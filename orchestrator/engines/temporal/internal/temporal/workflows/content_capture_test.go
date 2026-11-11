package workflows

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
)

// docs/adr/0050 §5: content capture is opt-in per Agent and forced off for
// anything acting with, or able to reach, a caller's credentials.
func TestContentEligible(t *testing.T) {
	optedIn := catalog.AgentDescriptor{ID: "a", ContentCapture: "content"}
	plain := []catalog.ToolDescriptor{{ID: "web-search"}}

	require.True(t, contentEligible(optedIn, "agent", plain))
	require.False(t, contentEligible(catalog.AgentDescriptor{ID: "a"}, "agent", plain), "not opted in")
	for _, mode := range []string{"delegated", "hybrid", ""} {
		require.False(t, contentEligible(optedIn, mode, plain), "mode %q reads as a caller, or is undecided", mode)
	}
	for name, tool := range map[string]catalog.ToolDescriptor{
		"knowledge base": {ID: "kb", KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{}},
		"mcp":            {ID: "m", MCPExec: &catalog.MCPExecSpec{}},
		"identity tool":  {ID: "gh", IdentityProviders: []string{"github"}},
	} {
		require.False(t, contentEligible(optedIn, "agent", append(plain, tool)), name)
	}
}
