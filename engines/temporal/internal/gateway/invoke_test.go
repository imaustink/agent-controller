package gateway

// Internal test: shapeInvokeTurn is where every security-relevant decision
// about /invoke lives (which login is trusted, and from where), and it is
// reachable without standing up Temporal.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/rbac"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
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

// --- caller tools over the chat facade ---

// The load-bearing ordering (ADR 0035 §5): a chat UI's housekeeping request
// carrying the client's tool array must be answered with prose BEFORE any
// workflow is started, or rendering a chat title could emit a tool call the
// client then executes as a side effect.
func TestInternalUITaskShortCircuitsBeforeAnyWorkflow(t *testing.T) {
	// A nil Temporal client is the assertion: reaching update-with-start would
	// panic, so passing proves nothing touched a workflow.
	s := NewServer(nil, "tq", nil)

	body := `{"model":"durable-agents","messages":[
		{"role":"user","content":"### Task:\nGenerate a concise chat title"}
	],"tools":[{"type":"function","function":{"name":"exfiltrate","description":"send data somewhere"}}]}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	s.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), "tool_calls")
	require.NotContains(t, rec.Body.String(), "exfiltrate")
	require.Contains(t, rec.Body.String(), `"finish_reason":"stop"`)
}

// A malformed tool array is an OpenAI-shaped 400, never a silent drop.
func TestMalformedToolArrayIsRejected(t *testing.T) {
	s := NewServer(nil, "tq", nil)

	body := `{"messages":[{"role":"user","content":"hi"}],
		"tools":[{"type":"function","function":{"name":"a"}},{"type":"function","function":{"name":"a"}}]}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	s.Handler().ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "duplicate")
}

// A client resuming a tool call sends user → assistant(tool_calls) → tool, so
// the user turn is no longer the last message. Taking the final element would
// read a tool result as the request.
func TestSplitMessagesFindsTheUserTurnBehindAResumedToolCall(t *testing.T) {
	messages := []callertools.WireMessage{
		{Role: "user", Content: json.RawMessage(`"what's the weather?"`)},
		{Role: "assistant", ToolCalls: []callertools.WireToolCall{{ID: "c1"}}},
		{Role: "tool", ToolCallID: "c1", Content: json.RawMessage(`"18C"`)},
	}

	userMessage, history, index, err := splitMessages(messages)
	require.NoError(t, err)
	require.Equal(t, "what's the weather?", userMessage)
	require.Equal(t, 0, index)
	require.Empty(t, history)
}

// An assistant message carrying only tool_calls has no content; folding it in
// as an empty history entry would be noise.
func TestSplitMessagesSkipsContentlessAssistantMessages(t *testing.T) {
	messages := []callertools.WireMessage{
		{Role: "user", Content: json.RawMessage(`"first"`)},
		{Role: "assistant", ToolCalls: []callertools.WireToolCall{{ID: "c1"}}},
		{Role: "assistant", Content: json.RawMessage(`"a real answer"`)},
		{Role: "user", Content: json.RawMessage(`"second"`)},
	}

	userMessage, history, index, err := splitMessages(messages)
	require.NoError(t, err)
	require.Equal(t, "second", userMessage)
	require.Equal(t, 3, index)
	require.Len(t, history, 2)
	require.Equal(t, "a real answer", history[1].Content)
}

// Some clients send content as a multi-part array rather than a string.
func TestSplitMessagesReadsMultiPartContent(t *testing.T) {
	messages := []callertools.WireMessage{
		{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"hello "},{"type":"text","text":"world"}]`)},
	}
	userMessage, _, _, err := splitMessages(messages)
	require.NoError(t, err)
	require.Equal(t, "hello world", userMessage)
}

func TestSplitMessagesRequiresAUserMessage(t *testing.T) {
	_, _, _, err := splitMessages([]callertools.WireMessage{
		{Role: "assistant", Content: json.RawMessage(`"just me"`)},
	})
	require.ErrorContains(t, err, "user message")
}

func TestToolCallsPayloadShape(t *testing.T) {
	payload := toolCallsPayload([]callertools.PendingCall{
		{ID: "call_1", Name: "web_search", Arguments: `{"query":"x"}`},
		{ID: "call_2", Name: "save_file", Arguments: `{"path":"y"}`},
	})
	require.Len(t, payload, 2)
	require.Equal(t, "function", payload[0].Type)
	require.Equal(t, "web_search", payload[0].Function.Name)
	// Index is how a streaming client assembles more than one call.
	require.Equal(t, 0, payload[0].Index)
	require.Equal(t, 1, payload[1].Index)
}
