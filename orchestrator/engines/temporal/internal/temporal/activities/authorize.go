package activities

import (
	"context"

	"go.temporal.io/sdk/activity"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
)

const (
	AuthorizeActivityName              = "Authorize"
	CheckIdentityActivityName          = "CheckIdentity"
	ResolveLinkedActivityName          = "ResolveLinked"
	ResolveToolCredentialsActivityName = "ResolveToolCredentials"
)

// AuthorizeInput is what the workflow hands the pre-flight. Note what is
// absent: nothing a model produced, and no credential.
type AuthorizeInput struct {
	AgentID           string   `json:"agentId"`
	IdentityProviders []string `json:"identityProviders,omitempty"`
	Caller            Caller   `json:"caller"`
	SenderLogin       string   `json:"senderLogin,omitempty"`
	// Flow is "device" for a caller with no browser to redirect.
	Flow string `json:"flow,omitempty"`
	// WaitForLink says this turn can show a prompt live, so waiting for the
	// human to finish is useful rather than merely hiding the prompt.
	WaitForLink       bool  `json:"waitForLink,omitempty"`
	RunTimeoutSeconds int32 `json:"runTimeoutSeconds,omitempty"`
	// Pending is the anchor from a turn that previously stopped on this
	// link, carried in on a resume so Authorize re-checks that outstanding
	// flow instead of starting a second one.
	Pending *authz.PendingLink `json:"pending,omitempty"`
	// TargetRepository is the "owner/name" the run will work in; see
	// authz.Request.TargetRepository.
	TargetRepository string `json:"targetRepository,omitempty"`
	// ReadOnly withholds write-capable credentials; see authz.Request.ReadOnly.
	ReadOnly bool `json:"readOnly,omitempty"`

	// DefaultIdentity / AllowedIdentities are the Agent's, IdentityOverride
	// the matched trigger's (docs/adr/0049); see authz.ResolveMode.
	DefaultIdentity   string   `json:"defaultIdentity,omitempty"`
	AllowedIdentities []string `json:"allowedIdentities,omitempty"`
	IdentityOverride  string   `json:"identityOverride,omitempty"`

	// TriggerName is the EventTrigger that produced the turn. Audit only: it
	// decides nothing here.
	TriggerName string `json:"triggerName,omitempty"`

	// DelegatedSubject / SenderAccountID / SenderSubjectStatus are the
	// gateway's signed sender claim (docs/adr/0049 §5); see
	// authz.Identity.DelegatedSubject and authz.Request.
	DelegatedSubject    string `json:"delegatedSubject,omitempty"`
	SenderAccountID     string `json:"senderAccountId,omitempty"`
	SenderSubjectStatus string `json:"senderSubjectStatus,omitempty"`
}

// AuthorizeActivities is the workflow-facing side of the pre-flight.
//
// The activity boundary is the credential boundary: authz.Service resolves
// credentials, writes them to a Secret, and returns a NAME. An activity result
// is persisted to Temporal event history, so anything that came back here
// carrying a token would be durable plaintext for the workflow's whole
// retention — a weaker property than the upstream node-local variable this
// replaces, not an equal one.
type AuthorizeActivities struct {
	Service *authz.Service
}

func (in AuthorizeInput) request() authz.Request {
	return authz.Request{
		AgentID:           in.AgentID,
		IdentityProviders: in.IdentityProviders,
		Identity: authz.Identity{
			Subject:          in.Caller.Subject,
			Roles:            in.Caller.Roles,
			Principal:        in.Caller.Principal,
			PerUser:          in.Caller.PerUser,
			DelegatedSubject: in.DelegatedSubject,
		},
		SenderLogin:         in.SenderLogin,
		SenderAccountID:     in.SenderAccountID,
		SenderSubjectStatus: in.SenderSubjectStatus,
		Flow:                in.Flow,
		WaitForLink:         in.WaitForLink,
		RunTimeoutSeconds:   in.RunTimeoutSeconds,
		Pending:             in.Pending,
		TargetRepository:    in.TargetRepository,
		ReadOnly:            in.ReadOnly,
		DefaultIdentity:     in.DefaultIdentity,
		AllowedIdentities:   in.AllowedIdentities,
		IdentityOverride:    in.IdentityOverride,
	}
}

// Authorize runs the full pre-flight, which may start link flows, and writes
// the decision's audit record (docs/adr/0049 §3) before returning it: every
// outcome, including a refusal, is on the record before anything starts.
func (a *AuthorizeActivities) Authorize(ctx context.Context, in AuthorizeInput) (authz.Verdict, error) {
	v, err := a.Service.Authorize(ctx, in.request())
	if err != nil {
		// Retried by Temporal; the attempt that settles writes the record.
		return v, err
	}
	v.DecisionID = decisionID(ctx)
	annotatePreflightSpan(ctx, in, v)
	info := activity.GetInfo(ctx)
	audit.Emit(audit.Record{
		Kind:         audit.KindAuthorization,
		Agent:        in.AgentID,
		Outcome:      string(v.Kind),
		Conversation: info.WorkflowExecution.ID,
		Launch:       LaunchRecord(in, v),
	})
	return v, nil
}

// decisionID names one pre-flight decision. Stable across retries of the same
// activity (the attempt number is not part of it), so the record written by
// the attempt that settled and the AgentRun it launched always agree.
func decisionID(ctx context.Context) string {
	info := activity.GetInfo(ctx)
	return info.WorkflowExecution.RunID + "/" + info.ActivityID
}

// LaunchRecord is the audit view of a pre-flight decision. Pure, so the
// workflow can rebuild exactly what the activity recorded and carry it to the
// launcher without another activity.
func LaunchRecord(in AuthorizeInput, v authz.Verdict) audit.Launch {
	l := audit.Launch{
		DecisionID:            v.DecisionID,
		EntryPoint:            audit.EntryPoint(in.Caller.PerUser, in.TriggerName, in.SenderLogin),
		LaunchedBy:            in.Caller.Subject,
		DelegatedSubject:      in.DelegatedSubject,
		Trigger:               in.TriggerName,
		RequestedIdentityMode: string(v.RequestedIdentityMode),
		IdentityMode:          string(v.IdentityMode),
		IdentityModeSource:    string(v.IdentityModeSource),
		TargetRepository:      in.TargetRepository,
		ReadOnly:              in.ReadOnly,
	}
	if in.SenderLogin != "" {
		l.Sender = &audit.Sender{Provider: "github", Login: in.SenderLogin, AccountID: in.SenderAccountID}
	}
	for _, c := range v.Credentials {
		l.Credentials = append(l.Credentials, audit.Credential{Provider: c.Provider, Read: c.Read, Write: c.Write})
	}
	return l
}

// CheckIdentity is the accept-phase identity check (docs/adr/0049 §6): read
// only, never starts a link flow, writes nothing. Nil means no objection.
func (a *AuthorizeActivities) CheckIdentity(ctx context.Context, in AuthorizeInput) (*authz.IdentityError, error) {
	return a.Service.CheckIdentity(ctx, in.request()), nil
}

// ResolveLinked is the read-only variant for a paused tool call, which has no
// resume slot and therefore must never start a link flow.
func (a *AuthorizeActivities) ResolveLinked(ctx context.Context, in AuthorizeInput) (authz.Verdict, error) {
	return a.Service.ResolveLinked(ctx, in.request())
}

// ToolCredentialsInput asks whether a container Tool's declared identities are
// satisfied for this caller (upstream ADR 0032 §5).
type ToolCredentialsInput struct {
	Tool   catalog.ToolDescriptor `json:"tool"`
	Caller Caller                 `json:"caller"`
	// ReadOnly refuses a tool that would act on GitHub as the caller; see
	// authz.Service.ResolveLinked.
	ReadOnly bool `json:"readOnly,omitempty"`
}

// ResolveToolCredentials gates a container Tool launch on the caller having
// linked whatever the Tool declares.
//
// Routed through the same owner as the agent path deliberately. Upstream's
// equivalent started as a hand-copied provider loop with its own keying rules,
// and two copies of credential keying was the shape of its PR #144 bug; the
// consolidation into one owner is what removed the second copy.
func (a *AuthorizeActivities) ResolveToolCredentials(ctx context.Context, in ToolCredentialsInput) (authz.Verdict, error) {
	return a.Service.ResolveLinked(ctx, authz.Request{
		AgentID:           in.Tool.ID,
		IdentityProviders: in.Tool.IdentityProviders,
		Identity: authz.Identity{
			Subject:   in.Caller.Subject,
			Roles:     in.Caller.Roles,
			Principal: in.Caller.Principal,
			PerUser:   in.Caller.PerUser,
		},
		ReadOnly: in.ReadOnly,
	})
}
