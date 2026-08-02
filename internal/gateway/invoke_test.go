package gateway

// Internal test: shapeInvokeTurn is where every security-relevant decision
// about /invoke lives (which login is trusted, and from where), and it is
// reachable without standing up Temporal.

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/catalog"
	"durable-agents/internal/rbac"
	"durable-agents/internal/temporal/activities"
)

const assertionSecret = "shared-with-integration-gateway"

var testCaller = activities.Caller{Subject: "svc:integration-gateway", Roles: []string{"agent"}}

func triageRoutes(t *testing.T) *catalog.RouteRegistry {
	t.Helper()
	reg := catalog.NewRouteRegistry()
	reg.Upsert(catalog.IntegrationRouteDescriptor{
		ID:             "github-issue-labeled-triage",
		Match:          catalog.IntegrationRouteMatch{Source: "github", Event: "issues", Action: "labeled", LabelName: "ai-triage"},
		AgentRef:       "claude-code-swe-agent",
		PromptTemplate: "Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}",
	})
	return reg
}

func issueEvent() map[string]any {
	return map[string]any{
		"source": "github", "event": "issues", "action": "labeled", "labelName": "ai-triage",
		"owner": "acme", "repo": "widgets", "issueNumber": float64(7), "title": "Crash on save",
		"senderLogin": "imaustink",
	}
}

func TestShapeInvokeTurnRendersAMatchedRoute(t *testing.T) {
	now := time.Now()
	turn, err := shapeInvokeTurn(
		invokeRequest{Request: "an issue was labeled", Event: issueEvent()},
		"", "", triageRoutes(t), testCaller, now,
	)
	require.NoError(t, err)

	require.Equal(t, "Triage acme/widgets#7: Crash on save", turn.Message,
		"the route's rendered template replaces the adapter's fallback text")
	require.Equal(t, "claude-code-swe-agent", turn.ForcedAgentID)
	require.Empty(t, turn.ForcedSkillID)
	require.Equal(t, testCaller, turn.Caller)
}

// A route's promptTemplate legitimately supplies the whole request, so an
// event-driven caller need not send request text of its own.
func TestShapeInvokeTurnAcceptsAnEmptyRequestWhenARouteSuppliesOne(t *testing.T) {
	turn, err := shapeInvokeTurn(
		invokeRequest{Request: "   ", Event: issueEvent()},
		"", "", triageRoutes(t), testCaller, time.Now(),
	)
	require.NoError(t, err)
	require.Equal(t, "Triage acme/widgets#7: Crash on save", turn.Message)
}

func TestShapeInvokeTurnRejectsAnEmptyRequestWithNothingToRender(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  invokeRequest
	}{
		{"no event at all", invokeRequest{Request: ""}},
		{"event matches no route", invokeRequest{Request: "", Event: map[string]any{"source": "slack", "event": "message"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := shapeInvokeTurn(tc.req, "", "", triageRoutes(t), testCaller, time.Now())
			require.ErrorIs(t, err, errEmptyRequest)
		})
	}
}

func TestShapeInvokeTurnFallsThroughWhenNoRouteMatches(t *testing.T) {
	turn, err := shapeInvokeTurn(
		invokeRequest{
			Request: "please look at this",
			Event:   map[string]any{"source": "github", "event": "issues", "action": "closed"},
		},
		"", "", triageRoutes(t), testCaller, time.Now(),
	)
	require.NoError(t, err)
	require.Equal(t, "please look at this", turn.Message, "unrouted turns keep their own text")
	require.Empty(t, turn.ForcedAgentID)
	require.Empty(t, turn.ForcedSkillID)
}

// Routing is optional: a deployment with no route table behaves exactly as it
// did before IntegrationRoute existed.
func TestShapeInvokeTurnWithoutARouteTable(t *testing.T) {
	turn, err := shapeInvokeTurn(
		invokeRequest{Request: "please look at this", Event: issueEvent()},
		"", "", nil, testCaller, time.Now(),
	)
	require.NoError(t, err)
	require.Equal(t, "please look at this", turn.Message)
	require.Empty(t, turn.ForcedAgentID)
}

// The security core of ADR 0030 §6. The sender login selects the principal
// that credentials are keyed by, so with a secret configured it must come
// ONLY from a verified assertion — anything holding this endpoint's token
// could otherwise name an arbitrary login and be handed that person's
// credentials.
func TestShapeInvokeTurnSenderLoginTrust(t *testing.T) {
	now := time.UnixMilli(1754150400000)
	valid := rbac.MintSenderAssertion(assertionSecret, "imaustink", rbac.DefaultAssertionTTL, now)

	t.Run("with a secret, a verified assertion is trusted", func(t *testing.T) {
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: issueEvent()},
			valid, assertionSecret, nil, testCaller, now,
		)
		require.NoError(t, err)
		require.Equal(t, "imaustink", turn.SenderLogin)
	})

	t.Run("with a secret, the unsigned body field is ignored entirely", func(t *testing.T) {
		event := issueEvent()
		event["senderLogin"] = "attacker"
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: event},
			"", assertionSecret, nil, testCaller, now,
		)
		require.NoError(t, err)
		require.Empty(t, turn.SenderLogin,
			"no assertion means no principal — never the login the body claimed")
	})

	t.Run("with a secret, a body field cannot override a verified assertion", func(t *testing.T) {
		event := issueEvent()
		event["senderLogin"] = "attacker"
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: event},
			valid, assertionSecret, nil, testCaller, now,
		)
		require.NoError(t, err)
		require.Equal(t, "imaustink", turn.SenderLogin)
	})

	t.Run("with a secret, an assertion signed by someone else is refused", func(t *testing.T) {
		forged := rbac.MintSenderAssertion("some-other-secret", "imaustink", rbac.DefaultAssertionTTL, now)
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: issueEvent()},
			forged, assertionSecret, nil, testCaller, now,
		)
		require.NoError(t, err)
		require.Empty(t, turn.SenderLogin)
	})

	t.Run("with a secret, an expired assertion is refused", func(t *testing.T) {
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: issueEvent()},
			valid, assertionSecret, nil, testCaller,
			now.Add(rbac.DefaultAssertionTTL+time.Second),
		)
		require.NoError(t, err)
		require.Empty(t, turn.SenderLogin)
	})

	// The documented weaker mode: upgrading a deployment must not silently
	// break it. Announced at startup by rbac.WarnIfSenderAssertionUnset.
	t.Run("without a secret, the body field is trusted", func(t *testing.T) {
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: issueEvent()},
			"", "", nil, testCaller, now,
		)
		require.NoError(t, err)
		require.Equal(t, "imaustink", turn.SenderLogin)
	})

	// The principal must resolve for every event-driven turn, including ones
	// that match no route — otherwise cross-entry-point credential sharing
	// would quietly depend on routing config.
	t.Run("resolves even when no route matches", func(t *testing.T) {
		turn, err := shapeInvokeTurn(
			invokeRequest{Request: "r", Event: map[string]any{"source": "slack", "event": "message", "senderLogin": "imaustink"}},
			"", "", triageRoutes(t), testCaller, now,
		)
		require.NoError(t, err)
		require.Equal(t, "imaustink", turn.SenderLogin)
		require.Empty(t, turn.ForcedAgentID)
	})
}

func TestInvocationIDRoundTrip(t *testing.T) {
	for _, tc := range []struct{ workflowID, updateID string }{
		{"conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"},
		{"conversation-github-imaustink-agent-controller-151", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"},
		{"conversation-a-b-c", "u"},
	} {
		id := encodeInvocationID(tc.workflowID, tc.updateID)
		gotWorkflow, gotUpdate, ok := decodeInvocationID(id)
		require.True(t, ok, id)
		require.Equal(t, tc.workflowID, gotWorkflow)
		require.Equal(t, tc.updateID, gotUpdate)
	}
}

func TestInvocationIDRejectsMalformed(t *testing.T) {
	for _, id := range []string{"", "no-separator", ".leading", "trailing."} {
		_, _, ok := decodeInvocationID(id)
		require.False(t, ok, id)
	}
}

// sanitizeID maps everything outside [A-Za-z0-9_-] to '-', so a session id
// carrying dots (a GitHub issue URL fragment, say) cannot smuggle a second
// separator into the workflow-id half and split the id in the wrong place.
func TestInvocationIDSurvivesADottySessionID(t *testing.T) {
	workflowID := "conversation-" + sanitizeID("github:acme/widgets#1.2.3")
	require.NotContains(t, workflowID, ".")

	id := encodeInvocationID(workflowID, "6ba7b810-9dad-11d1-80b4-00c04fd430c8")
	gotWorkflow, gotUpdate, ok := decodeInvocationID(id)
	require.True(t, ok)
	require.Equal(t, workflowID, gotWorkflow)
	require.Equal(t, "6ba7b810-9dad-11d1-80b4-00c04fd430c8", gotUpdate)
}
