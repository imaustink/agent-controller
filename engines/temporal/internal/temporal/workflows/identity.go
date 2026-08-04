package workflows

import (
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// credentials is a resolved credential REFERENCE: the Secret the pre-flight
// wrote and the keys inside it. Never a value — see internal/authz's package
// doc on Temporal event history.
type credentials struct {
	SecretName string   `json:"secretName,omitempty"`
	EnvVars    []string `json:"envVars,omitempty"`
}

// toolCredentials gates a container Tool launch on the caller having linked
// whatever the Tool declares (upstream ADR 0032 §5).
//
// Before this, only an agent-backed Tool had an identity gate; a genuine
// container Tool had none at all, so a Tool meant to act as the calling human
// could only ever run with a shared static token.
//
// Same v1 scope cut as upstream: this path never STARTS a link flow. A paused
// tool call has no resume slot to come back to, so a caller links once through
// a conversation with an identity-capable agent and only then can a skill route
// them here. The refusal says so.
func toolCredentials(
	ctx workflow.Context,
	actx workflow.Context,
	in TurnInput,
	tool catalog.ToolDescriptor,
) (creds credentials, refusal string) {
	if len(tool.IdentityProviders) == 0 {
		return credentials{}, ""
	}

	var verdict authz.Verdict
	if err := workflow.ExecuteActivity(actx, activities.ResolveToolCredentialsActivityName, activities.ToolCredentialsInput{
		Tool:   tool,
		Caller: in.Caller,
	}).Get(ctx, &verdict); err != nil {
		// Fail CLOSED. A tool that declares an identity must not run without
		// one because a lookup was unavailable — it would either fall back to
		// whatever static credential its template carries, or fail confusingly
		// inside the Job.
		workflow.GetLogger(ctx).Warn("tool identity check failed; refusing the call",
			"toolId", tool.ID, "error", err)
		return credentials{}, "I couldn't verify your linked accounts just now, so I didn't run " + tool.ID + "."
	}

	switch verdict.Kind {
	case authz.KindAuthorized:
		return credentials{SecretName: verdict.SecretName, EnvVars: verdict.EnvVarNames}, ""
	case authz.KindLinkRequired:
		return credentials{}, verdict.Message
	default:
		return credentials{}, "I can't run " + tool.ID + " right now: " + verdict.Error
	}
}

// resumePendingLink retries a delegation that stopped for an account link.
//
// handled=false means the anchor was stale and the turn should carry on
// normally. It is never an error: an expired flow, a revoked role, or a deleted
// Agent all just mean this turn is an ordinary one.
//
// Whether the link completed is read by re-running the pre-flight, never from
// the user's message. "Yes I linked it" is not evidence, and treating it as
// evidence would make the gate arguable.
func resumePendingLink(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	meta *TurnMeta,
	note func(string),
) (reply string, m TurnMeta, handled bool, err error) {
	anchor := state.PendingIdentityLink
	logger := workflow.GetLogger(ctx)

	if workflow.Now(ctx).UnixMilli() > anchor.ExpiresAt {
		logger.Info("pending identity link expired; continuing as an ordinary turn",
			"provider", anchor.Provider, "agentId", anchor.AgentID)
		state.PendingIdentityLink = nil
		return "", *meta, false, nil
	}

	// Re-resolve under CURRENT roles: an anchor is not a capability, and roles
	// may have been revoked while the caller was linking.
	var agent *catalog.AgentDescriptor
	if err := workflow.ExecuteActivity(actx, activities.ResolveAgentActivityName, activities.ResolveAgentInput{
		Caller:  in.Caller,
		AgentID: anchor.AgentID,
	}).Get(ctx, &agent); err != nil || agent == nil {
		logger.Info("pending identity link's agent is gone or no longer visible; dropping the anchor",
			"agentId", anchor.AgentID)
		state.PendingIdentityLink = nil
		return "", *meta, false, nil
	}

	// The goal, not this turn's text.
	resume := in
	if anchor.Request != "" {
		resume.Message = anchor.Request
	}
	note("Checking whether your " + anchor.Provider + " link completed…")

	reply, m, err = delegateToAgent(ctx, actx, state, resume, *agent, meta, note)
	return reply, m, true, err
}

// authorizeAgent is the pre-flight for an agent launch: plain control flow,
// never a capability a planner selects, and no model call participates.
//
// Run in the PARENT rather than inside the child workflow, mirroring upstream's
// delegateToAgent. Three reasons: the verdict decides whether to start a child
// at all; the link prompt becomes this turn's reply directly rather than
// arriving as an up-signal from a child that immediately gave up; and the
// pending-link anchor belongs to the conversation, which is the parent's state.
func authorizeAgent(
	ctx workflow.Context,
	actx workflow.Context,
	in TurnInput,
	agent catalog.AgentDescriptor,
) (authz.Verdict, error) {
	if len(agent.IdentityProviders) == 0 {
		return authz.Verdict{Kind: authz.KindAuthorized}, nil
	}

	// A caller with no live channel has no browser to redirect, so offer the
	// device flow: a code they can enter wherever they are.
	flow := "device"
	if in.Live {
		flow = "authcode"
	}

	var verdict authz.Verdict
	err := workflow.ExecuteActivity(actx, activities.AuthorizeActivityName, activities.AuthorizeInput{
		AgentID:           agent.ID,
		IdentityProviders: agent.IdentityProviders,
		Caller:            in.Caller,
		SenderLogin:       in.SenderLogin,
		Flow:              flow,
		WaitForLink:       in.Live,
		// Sizes the write-back grant only: it must outlive the run that may
		// refresh a credential mid-flight.
		RunTimeoutSeconds: podStepTimeoutSeconds,
	}).Get(ctx, &verdict)
	return verdict, err
}
