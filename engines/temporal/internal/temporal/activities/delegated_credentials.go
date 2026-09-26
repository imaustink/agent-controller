package activities

import (
	"context"
	"fmt"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// LinkedCredentials resolves the calling user's own credential for a knowledge
// base's providers, from the links the integration-gateway holds.
//
// This is the production DelegatedCredentialResolver. Without it every
// knowledge-base search answered "link your account first" — correctly, since
// probing on the ingestion credential would answer a different question,
// permissively (ADR 0040) — but unconditionally, for callers who had linked.
type LinkedCredentials struct {
	Links identitylink.Port
}

// DelegatedToken returns the first provider's credential this caller holds.
//
// FIRST, not all: the probe path carries ONE delegated token per turn, so a
// knowledge base spanning two providers can only be served by one of them
// today. That is a real limitation rather than a rounding error — a mixed
// Confluence-and-Slack knowledge base will silently probe Slack candidates with
// an Atlassian token and drop them — and it belongs to the prober's shape, not
// here. Providers are tried in the order the knowledge base declares them, so
// the choice is at least deterministic and operator-visible.
func (c *LinkedCredentials) DelegatedToken(
	ctx context.Context,
	caller Caller,
	providers []string,
) (DelegatedCredential, error) {
	for _, provider := range providers {
		subject := credentialSubject(caller, provider)

		token, err := c.Links.Token(ctx, provider, subject)
		if err != nil {
			// NOT swallowed into "nothing linked". A lookup that failed is
			// unknown, and reporting it as absent tells a caller to link an
			// account they already linked — on every turn, while the same
			// record works 0.3s later (ADR 0031's exact failure).
			return DelegatedCredential{}, fmt.Errorf(
				"credential lookup failed for %s@%s: %w", provider, subject, err)
		}
		if token == nil || token.Value == "" {
			continue
		}

		return DelegatedCredential{
			Token:      token.Value,
			Principals: c.principals(ctx, provider, subject),
		}, nil
	}

	// Nothing linked for any provider. Empty rather than an error: the activity
	// turns this into an ask, which is the honest response.
	return DelegatedCredential{}, nil
}

// principals is the provider-side identity this credential acts as, for the ACL
// mirror's pre-filter.
//
// Best-effort by design. It feeds a pre-filter that can only save probes, and
// PreFilter is written so an absent or partial set costs latency rather than
// correctness — so a failure here is logged by being ignored rather than
// failing a search that would otherwise succeed.
//
// Only the USER principal is resolved. Group membership needs a provider call
// nothing makes yet, and PreFilter therefore declines to exclude on group
// restrictions at all — which is the safe direction, and starts working by
// itself the day groups are supplied.
func (c *LinkedCredentials) principals(ctx context.Context, provider, subject string) []string {
	if accountID, err := c.Links.LinkedAccountID(ctx, provider, subject); err == nil && accountID != "" {
		return []string{"user:" + accountID}
	}
	// GitHub-shaped links report a login instead.
	if login, err := c.Links.LinkedLogin(ctx, provider, subject); err == nil && login != "" {
		return []string{"user:" + login}
	}
	return nil
}

// credentialSubject applies the SAME keying rule as the authorization
// pre-flight (authz.CrossEntryPointProviders).
//
// Reused rather than restated. A resolver that looked under a different key
// than the linker wrote to would find nothing and ask the caller to re-link
// forever, which is a loop this system has already been through once.
func credentialSubject(caller Caller, provider string) string {
	if authz.CrossEntryPointProviders[provider] && caller.Principal != "" {
		return caller.Principal
	}
	return caller.Subject
}
