package authz

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// connectionsLinkTTLSeconds is how long a Connections-page link prompt's anchor
// lives, matching a direct authcode link's `state` lifetime.
const connectionsLinkTTLSeconds = 10 * 60

// UsesConnectionsPage reports whether integration-gateway's Connections page
// (agent-controller docs/adr/0046) stands in for a provider's own link flow for
// this caller. PARITY: usesConnectionsPage in agent-orchestrator's
// authorization-service.ts.
//
// Only an Open WebUI chat caller qualifies: the page finds whose credentials to
// manage by mapping its sign-in back to an `openwebui:<id>` subject, so a
// webhook relay's subject (shared, with no browser session behind it) could
// never be found there. An explicit device-flow request keeps the device flow,
// since that caller asked for it precisely because it has no browser.
func UsesConnectionsPage(connectionsURL, callerSubject, flow string) bool {
	return connectionsURL != "" && flow != identitylink.FlowDevice && strings.HasPrefix(callerSubject, "openwebui:")
}

// ConnectionsPageStart is the page's one-click deep link for providers, shaped
// as a started flow so the anchor and prompt code treat it like any other.
// Nothing is started at a provider: the page starts each flow itself, for the
// same subject this turn reads, so the wait and resume paths are unchanged.
//
// connectionsURL names the page ("https://<gw>/connections"); the link is its
// "/link" route, which signs the user in (invisibly, on a live IdP session),
// skips what is already connected and goes straight to the first provider's
// consent, then on to the next. ok is false only for an unparseable URL.
func ConnectionsPageStart(connectionsURL string, providers []string) (identitylink.StartResult, bool) {
	u, err := url.Parse(connectionsURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return identitylink.StartResult{}, false
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/link"
	q := u.Query()
	q.Set("need", strings.Join(providers, ","))
	u.RawQuery = q.Encode()
	return identitylink.StartResult{
		Flow:             identitylink.FlowPage,
		PageURL:          u.String(),
		ExpiresInSeconds: connectionsLinkTTLSeconds,
	}, true
}

// ConnectionsLinkText is the prompt clause for a Connections-page link: the
// ordinary wording for one provider, or one link naming all of them.
// PARITY: connectionsLinkText in authorization-service.ts.
func ConnectionsLinkText(started identitylink.StartResult, labels []string) string {
	if len(labels) <= 1 {
		return linkPromptText(started, strings.Join(labels, ""))
	}
	return fmt.Sprintf("[connect your %s accounts](%s)", JoinLabels(labels), started.PageURL)
}

// JoinLabels renders "A", "A and B", "A, B and C".
func JoinLabels(labels []string) string {
	if len(labels) <= 1 {
		return strings.Join(labels, "")
	}
	return strings.Join(labels[:len(labels)-1], ", ") + " and " + labels[len(labels)-1]
}

// Label is a provider's human name, as prompts show it.
func Label(provider string) string { return label(provider) }
