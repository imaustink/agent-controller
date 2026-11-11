package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/activities"
)

// IdentityCheckWorkflowName is the accept-phase identity check (docs/adr/0049
// §6). A workflow only so the check runs where authorization lives -- the
// worker, which holds the catalog and the identity-link client -- instead of
// growing a second copy of it in the gateway. Short, stateless, never retried
// past its deadline: the gateway treats no answer as "no objection".
const IdentityCheckWorkflowName = "IdentityCheckWorkflow"

// IdentityCheckInput is a turn's identity-relevant fields.
type IdentityCheckInput struct {
	Caller              activities.Caller `json:"caller"`
	AgentID             string            `json:"agentId"`
	IdentityOverride    string            `json:"identityOverride,omitempty"`
	SenderLogin         string            `json:"senderLogin,omitempty"`
	DelegatedSubject    string            `json:"delegatedSubject,omitempty"`
	SenderAccountID     string            `json:"senderAccountId,omitempty"`
	SenderSubjectStatus string            `json:"senderSubjectStatus,omitempty"`
}

// IdentityCheckWorkflow resolves the forced agent under the caller's CURRENT
// roles and asks the pre-flight's read-only check whether it can act as the
// sender. Nil: no objection (or nothing decidable here).
func IdentityCheckWorkflow(ctx workflow.Context, in IdentityCheckInput) (*authz.IdentityError, error) {
	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	})
	var agent *catalog.AgentDescriptor
	if err := workflow.ExecuteActivity(actx, activities.ResolveAgentActivityName, activities.ResolveAgentInput{
		Caller:  in.Caller,
		AgentID: in.AgentID,
	}).Get(ctx, &agent); err != nil || agent == nil {
		return nil, nil // not visible / gone: the turn itself reports that
	}
	var ie *authz.IdentityError
	if err := workflow.ExecuteActivity(actx, activities.CheckIdentityActivityName, activities.AuthorizeInput{
		AgentID:             agent.ID,
		IdentityProviders:   agent.IdentityProviders,
		Caller:              in.Caller,
		SenderLogin:         in.SenderLogin,
		DefaultIdentity:     agent.DefaultIdentity,
		AllowedIdentities:   agent.AllowedIdentities,
		IdentityOverride:    in.IdentityOverride,
		DelegatedSubject:    in.DelegatedSubject,
		SenderAccountID:     in.SenderAccountID,
		SenderSubjectStatus: in.SenderSubjectStatus,
	}).Get(ctx, &ie); err != nil {
		return nil, nil
	}
	return ie, nil
}
