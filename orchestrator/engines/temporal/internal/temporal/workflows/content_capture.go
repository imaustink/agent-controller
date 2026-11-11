package workflows

import (
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
)

// contentEligible decides whether a pod agent run may record prompt and
// output text on its traces, before the deployment ceiling (docs/adr/0050 §5).
// Pure and deterministic: everything it reads is workflow input.
//
// Text from a caller's own credentials must not land in a trace backend more
// people can read than the source allows (ADR 0040), so a run is ineligible
// when it acts with a caller's credentials (delegated/hybrid, or no decided
// mode at all) or can reach a tool that does: a knowledge base (always
// per-user hydrated), an MCP tool, or any tool declaring identity providers.
func contentEligible(agent catalog.AgentDescriptor, mode string, declared []catalog.ToolDescriptor) bool {
	if agent.ContentCapture != "content" || mode != "agent" {
		return false
	}
	for _, t := range declared {
		if t.KnowledgeBaseExec != nil || t.MCPExec != nil || len(t.IdentityProviders) > 0 {
			return false
		}
	}
	return true
}
