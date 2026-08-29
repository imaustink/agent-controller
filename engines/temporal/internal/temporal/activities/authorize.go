package activities

import (
	"context"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/catalog"
)

const (
	AuthorizeActivityName              = "Authorize"
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
			Subject:   in.Caller.Subject,
			Roles:     in.Caller.Roles,
			Principal: in.Caller.Principal,
			PerUser:   in.Caller.PerUser,
		},
		SenderLogin:       in.SenderLogin,
		Flow:              in.Flow,
		WaitForLink:       in.WaitForLink,
		RunTimeoutSeconds: in.RunTimeoutSeconds,
		Pending:           in.Pending,
	}
}

// Authorize runs the full pre-flight, which may start link flows.
func (a *AuthorizeActivities) Authorize(ctx context.Context, in AuthorizeInput) (authz.Verdict, error) {
	return a.Service.Authorize(ctx, in.request())
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
	})
}
