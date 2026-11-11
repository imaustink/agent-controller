package authz

import (
	"context"
	"fmt"
	"strings"
)

// Identity error codes (docs/adr/0049 §6). A webhook consumer resolves these;
// the system never prompts on a sender's behalf.
const (
	// CodeIdentityLinkRequired: the sender has no usable linked account.
	CodeIdentityLinkRequired = "identity_link_required"
	// CodeIdentityAmbiguous: the sender's account is linked under several
	// subjects, so whose links to use cannot be decided.
	CodeIdentityAmbiguous = "identity_ambiguous"
	// CodeIdentityUnavailable: whether the sender is linked could not be
	// determined (the lookup failed or is not configured). Retryable.
	CodeIdentityUnavailable = "identity_unavailable"
)

// IdentityError is why a launch that must act as its webhook sender cannot,
// shaped for the consumer to print and act on. It names no subject: an
// ambiguous sender must not learn whose accounts their login collides with.
type IdentityError struct {
	Code         string            `json:"code"`
	Message      string            `json:"message"`
	IdentityMode IdentityMode      `json:"identityMode,omitempty"`
	Target       *IdentityTarget   `json:"target,omitempty"`
	Sender       *IdentitySender   `json:"sender,omitempty"`
	Missing      []MissingIdentity `json:"missing,omitempty"`
}

type IdentityTarget struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type IdentitySender struct {
	Provider  string `json:"provider"`
	Login     string `json:"login,omitempty"`
	AccountID string `json:"accountId,omitempty"`
}

// MissingIdentity is one account the sender must link. LinkURL is the
// Connections page (ADR 0046) when one is configured, else omitted.
type MissingIdentity struct {
	Provider string `json:"provider"`
	Label    string `json:"label"`
	LinkURL  string `json:"linkUrl,omitempty"`
}

// identityError builds the error for a caller-mode launch whose webhook
// sender cannot be acted as. status is the gateway's subject status;
// missing are the resource providers the sender must link (all of the
// agent's when the sender resolved to no subject at all).
func (s *Service) identityError(req Request, mode IdentityMode, status string, missing []string) *IdentityError {
	e := &IdentityError{
		IdentityMode: mode,
		Target:       &IdentityTarget{Kind: "agent", Name: req.AgentID},
	}
	if req.SenderLogin != "" {
		e.Sender = &IdentitySender{Provider: "github", Login: req.SenderLogin, AccountID: req.SenderAccountID}
	}
	who := req.SenderLogin
	if who == "" {
		who = "The person who triggered this"
	}

	switch status {
	case "ambiguous":
		e.Code = CodeIdentityAmbiguous
		e.Message = fmt.Sprintf("%s: your GitHub account is linked to more than one user here, so %s can't tell whose "+
			"accounts to act with. Unlink it from all but one, then try again.", who, req.AgentID)
		return e
	case "unavailable", "":
		// "" is a sender the gateway resolved no account id for (the source
		// sets no accountIdFrom): linking would not help, so it is reported
		// as undeterminable, never as "go link".
		e.Code = CodeIdentityUnavailable
		e.Message = fmt.Sprintf("%s: I couldn't check whether your accounts are linked, so %s didn't start. Try again shortly.",
			who, req.AgentID)
		return e
	}

	e.Code = CodeIdentityLinkRequired
	var link string
	if len(missing) > 0 && s.deps.ConnectionsURL != "" {
		if started, ok := ConnectionsPageStart(s.deps.ConnectionsURL, missing); ok {
			link = started.PageURL
		}
	}
	labels := make([]string, len(missing))
	for i, p := range missing {
		labels[i] = label(p)
		e.Missing = append(e.Missing, MissingIdentity{Provider: p, Label: label(p), LinkURL: link})
	}
	accounts := JoinLabels(labels) + " account"
	if len(labels) > 1 {
		accounts += "s"
	}
	if link != "" {
		e.Message = fmt.Sprintf("%s: link your %s so %s can act as you: %s", who, accounts, req.AgentID, link)
	} else {
		e.Message = fmt.Sprintf("%s: link your %s (ask me in chat to set it up) so %s can act as you, then try again.",
			who, accounts, req.AgentID)
	}
	return e
}

// callerResourceProviders are the declared providers a caller-mode run reads
// with the caller's own credential.
func callerResourceProviders(declared []string) []string {
	var out []string
	for _, p := range declared {
		if !RuntimeProviders[p] {
			out = append(out, p)
		}
	}
	return out
}

// isWebhookSender reports whether a request comes from a shared subject on
// behalf of a vouched-for sender (as opposed to a per-user chat caller, or a
// shared caller with nobody behind it).
func isWebhookSender(req Request) bool {
	return !req.Identity.PerUser && strings.TrimSpace(req.SenderLogin) != ""
}

// CheckIdentity is the accept-phase identity check (docs/adr/0049 §6): it
// answers, without starting a link flow or writing anything, whether a launch
// that must act as its webhook sender can. Nil means "no identity objection" --
// including every case it cannot decide, since the run's own pre-flight
// (Authorize) remains the authoritative check and refuses the same way. It
// exists only so a webhook consumer hears a refusal synchronously.
func (s *Service) CheckIdentity(ctx context.Context, req Request) *IdentityError {
	mode, refusal, err := s.decideMode(req)
	if err != nil {
		return nil // misconfigured: not the sender's to fix; the run reports it
	}
	if refusal != nil {
		return refusal.IdentityError
	}
	if !mode.run.usesCaller() || req.Identity.PerUser || req.Identity.DelegatedSubject == "" || s.deps.Links == nil {
		return nil
	}
	var missing []string
	for _, p := range callerResourceProviders(req.IdentityProviders) {
		token, err := s.deps.Links.Token(ctx, p, req.Identity.DelegatedSubject)
		if err != nil {
			return nil // undecidable here; the run decides
		}
		if token == nil {
			missing = append(missing, p)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return s.identityError(req, mode.requested, "unlinked", missing)
}
