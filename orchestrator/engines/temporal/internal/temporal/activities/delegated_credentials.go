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

// DelegatedToken returns the first linked provider's credential this caller
// holds.
//
// For the single-resource paths — the document reader and the live lookup —
// which address ONE connection, and so one provider, per call. The multi-member
// search path uses DelegatedTokens instead, because a knowledge base can span
// providers and each must be probed with its own token.
//
// Providers are tried in the order the knowledge base declares them, so the
// choice is deterministic.
func (c *LinkedCredentials) DelegatedToken(
	ctx context.Context,
	caller Caller,
	providers []string,
) (DelegatedCredential, error) {
	for _, provider := range providers {
		credential, err := c.resolveOne(ctx, caller, provider)
		if err != nil {
			return DelegatedCredential{}, err
		}
		if credential.Token != "" {
			return credential, nil
		}
	}

	// Nothing linked for any provider. Empty rather than an error: the activity
	// turns this into an ask, which is the honest response.
	return DelegatedCredential{}, nil
}

// DelegatedTokens returns a credential PER PROVIDER the caller has linked, keyed
// by provider name.
//
// All of them, not the first: the probe path can now carry one token per
// connection, so a knowledge base spanning Confluence, Drive and Slack serves
// every source the caller has linked the account for — and the searcher turns
// the ones they have NOT linked into an honest "link this to see more" rather
// than probing them with the wrong provider's token and dropping them. A
// provider the caller has not linked is simply absent from the map; a genuine
// lookup failure still propagates (ADR 0031), never read as an absent link.
func (c *LinkedCredentials) DelegatedTokens(
	ctx context.Context,
	caller Caller,
	providers []string,
) (map[string]DelegatedCredential, error) {
	resolved := make(map[string]DelegatedCredential, len(providers))
	for _, provider := range providers {
		credential, err := c.resolveOne(ctx, caller, provider)
		if err != nil {
			return nil, err
		}
		if credential.Token != "" {
			resolved[provider] = credential
		}
	}
	return resolved, nil
}

// resolveOne returns this caller's credential for one provider, or a zero
// credential when they have not linked it.
//
// A lookup that FAILED is returned as an error, never as an absent link: the
// two mean opposite things, and reporting a failure as absent tells a caller to
// link an account they already linked — on every turn, while the same record
// works 0.3s later (ADR 0031's exact failure).
func (c *LinkedCredentials) resolveOne(ctx context.Context, caller Caller, provider string) (DelegatedCredential, error) {
	subject := credentialSubject(caller, provider)

	token, err := c.Links.Token(ctx, provider, subject)
	if err != nil {
		return DelegatedCredential{}, fmt.Errorf(
			"credential lookup failed for %s@%s: %w", provider, subject, err)
	}
	if token == nil || token.Value == "" {
		return DelegatedCredential{}, nil
	}

	return DelegatedCredential{
		Token:      token.Value,
		Principals: c.principals(ctx, provider, subject),
	}, nil
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
