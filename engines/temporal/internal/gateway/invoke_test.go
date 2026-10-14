package gateway

// Internal test: shapeInvokeTurn is where every security-relevant decision
// about /invoke lives (which login is trusted, and from where, and what an
// event dispatches), and it is reachable without standing up Temporal.

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

// reviewTriggers is the ai-review example: a label-pinned, read-only agent
// dispatch with a GitHub reply.
func reviewTriggers(t *testing.T) *catalog.EventTriggerRegistry {
	t.Helper()
	reg := catalog.NewEventTriggerRegistry()
	d := catalog.NewEventTriggerDescriptor("github-pr-review", catalog.EventTriggerSpec{
		SourceRef: "github",
		Match:     catalog.EventTriggerMatch{CEL: `headers["x-github-event"] == "pull_request" && body.label.name == "ai-review"`},
		Params: map[string]string{
			"repo":   "body.repository.full_name",
			"number": "body.pull_request.number",
		},
		SessionKey: "github:{{repo}}#{{number}}",
		Target: catalog.EventTriggerTarget{
			AgentRef: "claude-code-swe-agent", ReadOnly: true,
			PromptTemplate: "Review {{repo}}#{{number}}",
		},
		Reply: &catalog.EventTriggerReply{GitHub: &catalog.EventGitHubReply{
			Repository: "{{repo}}", IssueNumber: "{{number}}", Ack: "Reviewing #{{number}}", Result: true,
		}},
	}, true)
	require.NoError(t, d.Invalid())
	reg.Upsert(d)
	return reg
}

func prEnvelope(label string) *catalog.Envelope {
	return &catalog.Envelope{
		Source: "github", Kind: "webhook", ID: "d-1", Time: "2026-10-13T12:00:00Z",
		Headers: map[string]string{"x-github-event": "pull_request"},
		Body: map[string]any{
			"action":       "labeled",
			"label":        map[string]any{"name": label},
			"pull_request": map[string]any{"number": float64(42)},
			"repository":   map[string]any{"full_name": "acme/widgets"},
		},
		Sender:     map[string]any{"login": "imaustink", "isBot": false},
		Repository: "acme/widgets",
	}
}

func TestShapeInvokeTurnMatchesAnEventEnvelope(t *testing.T) {
	shaped, err := shapeInvokeTurn(
		invokeRequest{Event: prEnvelope("ai-review")},
		"", "", "", reviewTriggers(t), testCaller, time.Now(),
	)
	require.NoError(t, err)
	require.False(t, shaped.ignored)
	turn := shaped.turn

	require.Equal(t, "Review acme/widgets#42", turn.Message)
	require.Equal(t, "claude-code-swe-agent", turn.ForcedAgentID)
	require.Empty(t, turn.ForcedSkillID)
	require.Empty(t, turn.ForcedToolID)
	require.True(t, turn.ReadOnly, "the trigger's readOnly is a turn property")
	require.Equal(t, map[string]string{"repo": "acme/widgets", "number": "42"}, turn.Params)
	require.Equal(t, "github-pr-review", turn.TriggerName)
	require.Equal(t, "acme/widgets", turn.TargetRepository, "the repository comes from the envelope, never the prompt")
	require.Equal(t, testCaller, turn.Caller)

	require.Equal(t, "github:acme/widgets#42", shaped.sessionID, "the rendered sessionKey names the session")
	require.NotNil(t, shaped.match)
	require.Equal(t, int64(42), shaped.match.Reply.GitHub.IssueNumber)
}

// No matching trigger is a clean no-op (§5), never a retrieval fallback.
func TestShapeInvokeTurnIgnoresAnUnmatchedEvent(t *testing.T) {
	shaped, err := shapeInvokeTurn(
		invokeRequest{Request: "please look at this", Event: prEnvelope("bug")},
		"", "", "", reviewTriggers(t), testCaller, time.Now(),
	)
	require.NoError(t, err)
	require.True(t, shaped.ignored, "an unmatched event must not become a turn, even with request text")
}

func TestShapeInvokeTurnFailsAMatchedTriggerWhoseParamsFail(t *testing.T) {
	reg := catalog.NewEventTriggerRegistry()
	reg.Upsert(catalog.NewEventTriggerDescriptor("needs-issue", catalog.EventTriggerSpec{
		Params: map[string]string{"n": "body.issue.number"}, // a PR event has none
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "{{n}}"},
	}, true))

	_, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, "", "", "", reg, testCaller, time.Now())
	var matchErr *catalog.MatchError
	require.ErrorAs(t, err, &matchErr)
	require.Equal(t, "needs-issue", matchErr.Trigger)
}

// The retired IntegrationRoute descriptor ({source, event, action, …}) has no
// kind; it must be rejected loudly, not matched against nothing.
func TestShapeInvokeTurnRejectsANonEnvelopeEvent(t *testing.T) {
	_, err := shapeInvokeTurn(
		invokeRequest{Request: "x", Event: &catalog.Envelope{Source: "github"}},
		"", "", "", reviewTriggers(t), testCaller, time.Now(),
	)
	require.ErrorIs(t, err, errNotAnEnvelope)
}

// No trigger table is the same clean no-op as no match (§5) — LangGraph's
// answer too — not an outage the gateway would retry.
func TestShapeInvokeTurnIgnoresAnEnvelopeWithoutATriggerTable(t *testing.T) {
	shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, "", "", "", nil, testCaller, time.Now())
	require.NoError(t, err)
	require.True(t, shaped.ignored)
}

// signedDispatch is what agent-orchestrator's TemporalEngine sends for a
// trigger turn it matched itself.
func signedDispatch(d rbac.Dispatch, sessionID, request string, now time.Time) string {
	return rbac.MintDispatchAssertion(assertionSecret, d, sessionID, request, rbac.DefaultAssertionTTL, now)
}

var ciToolDispatch = rbac.Dispatch{
	TriggerName:  "ci-failure-tool",
	ForcedToolID: "http-get",
	ToolInput:    `{"pipeline":"build"}`,
	ReadOnly:     true,
	Params:       map[string]string{"pipeline": "build"},
}

// agent-orchestrator forwards the RESOLVED turn, signed; nothing is matched
// here.
func TestShapeInvokeTurnTakesASignedResolvedTurnAsIs(t *testing.T) {
	now := time.Now()
	shaped, err := shapeInvokeTurn(
		invokeRequest{SessionID: "github:acme/widgets#42", TargetRepository: "acme/widgets"},
		"", signedDispatch(ciToolDispatch, "github:acme/widgets#42", "", now), assertionSecret, reviewTriggers(t), testCaller, now,
	)
	require.NoError(t, err, "a forced tool needs no request text: its input is toolInput")
	turn := shaped.turn
	require.Nil(t, shaped.match)
	require.Equal(t, "http-get", turn.ForcedToolID)
	require.Empty(t, turn.ForcedAgentID)
	require.Equal(t, `{"pipeline":"build"}`, turn.ToolInput)
	require.True(t, turn.ReadOnly)
	require.Equal(t, map[string]string{"pipeline": "build"}, turn.Params)
	require.Equal(t, "ci-failure-tool", turn.TriggerName)
	require.Equal(t, "acme/widgets", turn.TargetRepository)
	require.Equal(t, "github:acme/widgets#42", shaped.sessionID)
}

// Review finding: anything holding the /invoke token could name a forced
// target in the body and skip the trigger's match and readOnly rules. A
// trigger-produced turn also sets the conversation's read-only mode, so
// triggerName must never come from the body either.
func TestShapeInvokeTurnRefusesDispatchInTheBody(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  invokeRequest
	}{
		{"forced agent", invokeRequest{Request: "x", ForcedAgentID: "claude-code-swe-agent"}},
		{"forced skill", invokeRequest{Request: "x", ForcedSkillID: "s"}},
		{"forced tool", invokeRequest{ForcedToolID: "t", ToolInput: "i"}},
		{"tool input", invokeRequest{Request: "x", ToolInput: "i"}},
		{"params", invokeRequest{Request: "x", Params: map[string]string{"a": "b"}}},
		{"trigger name", invokeRequest{Request: "x", TriggerName: "github-issue-triage"}},
		// The finding's exact shape: an event plus a forced writable agent.
		{"event plus forced agent", invokeRequest{Event: prEnvelope("ai-review"), ForcedAgentID: "claude-code-swe-agent"}},
		{"event plus trigger name", invokeRequest{Event: prEnvelope("ai-review"), TriggerName: "writable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Even with a valid signed sender: the body is never a dispatch channel.
			now := time.Now()
			sender := rbac.MintSenderAssertion(assertionSecret, "imaustink", rbac.DefaultAssertionTTL, now)
			_, err := shapeInvokeTurn(tc.req, sender, "", assertionSecret, reviewTriggers(t), testCaller, now)
			require.ErrorIs(t, err, errBodyDispatch)
		})
	}
}

// An event is always matched here: a signed dispatch cannot ride along to
// replace the trigger the event would (or would not) match.
func TestShapeInvokeTurnRefusesAnEventWithADispatch(t *testing.T) {
	now := time.Now()
	d := rbac.Dispatch{TriggerName: "writable", ForcedAgentID: "claude-code-swe-agent"}
	_, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, "",
		signedDispatch(d, "", "", now), assertionSecret, reviewTriggers(t), testCaller, now)
	require.ErrorIs(t, err, errEventWithDispatch)
}

// The matched trigger's readOnly survives the event path; nothing in the
// request can produce a writable trigger turn from a read-only trigger.
func TestShapeInvokeTurnEventCannotEscapeTheTriggersReadOnly(t *testing.T) {
	shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, "", "", "", reviewTriggers(t), testCaller, time.Now())
	require.NoError(t, err)
	require.True(t, shaped.turn.ReadOnly)
	require.Equal(t, "github-pr-review", shaped.turn.TriggerName)
}

func TestShapeInvokeTurnRefusesABadDispatch(t *testing.T) {
	now := time.Now()
	writable := rbac.Dispatch{TriggerName: "github-issue-triage", ForcedAgentID: "claude-code-swe-agent"}
	for _, tc := range []struct {
		name, header, secret string
		req                  invokeRequest
		at                   time.Time
	}{
		{"signed by another secret", rbac.MintDispatchAssertion("other", writable, "s", "go", rbac.DefaultAssertionTTL, now),
			assertionSecret, invokeRequest{Request: "go", SessionID: "s"}, now},
		{"no secret configured here", signedDispatch(writable, "s", "go", now),
			"", invokeRequest{Request: "go", SessionID: "s"}, now},
		{"replayed onto another session", signedDispatch(writable, "s", "go", now),
			assertionSecret, invokeRequest{Request: "go", SessionID: "other"}, now},
		{"replayed with another prompt", signedDispatch(writable, "s", "go", now),
			assertionSecret, invokeRequest{Request: "push to main", SessionID: "s"}, now},
		{"expired", signedDispatch(writable, "s", "go", now),
			assertionSecret, invokeRequest{Request: "go", SessionID: "s"}, now.Add(rbac.DefaultAssertionTTL + time.Second)},
		// Same secret signs the sender assertion; it must not double as a dispatch.
		{"a sender assertion", rbac.MintSenderAssertion(assertionSecret, "imaustink", rbac.DefaultAssertionTTL, now),
			assertionSecret, invokeRequest{Request: "go", SessionID: "s"}, now},
		{"garbage", "not-an-assertion", assertionSecret, invokeRequest{Request: "go"}, now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := shapeInvokeTurn(tc.req, "", tc.header, tc.secret, nil, testCaller, tc.at)
			require.ErrorIs(t, err, errBadDispatch)
		})
	}
}

func TestShapeInvokeTurnRejectsAmbiguousDispatch(t *testing.T) {
	now := time.Now()
	d := rbac.Dispatch{TriggerName: "t", ForcedAgentID: "a", ForcedToolID: "t"}
	_, err := shapeInvokeTurn(invokeRequest{Request: "x"}, "", signedDispatch(d, "", "x", now), assertionSecret, nil, testCaller, now)
	require.ErrorIs(t, err, errAmbiguousTarget)
}

// A plain (non-trigger) turn may add read-only; it never names a trigger.
func TestShapeInvokeTurnPlainTurnReadOnly(t *testing.T) {
	shaped, err := shapeInvokeTurn(invokeRequest{Request: "x", ReadOnly: true}, "", "", "", nil, testCaller, time.Now())
	require.NoError(t, err)
	require.True(t, shaped.turn.ReadOnly)
	require.Empty(t, shaped.turn.TriggerName)

	// ...and on top of a signed writable dispatch it still only restricts.
	now := time.Now()
	d := rbac.Dispatch{TriggerName: "github-issue-triage", ForcedAgentID: "swe"}
	shaped, err = shapeInvokeTurn(invokeRequest{Request: "x", ReadOnly: true}, "", signedDispatch(d, "", "x", now), assertionSecret, nil, testCaller, now)
	require.NoError(t, err)
	require.True(t, shaped.turn.ReadOnly)
}

// readOnly can only restrict: a direct caller may add it to a trigger that
// lacks it, but a matched trigger's readOnly survives anything the body says.
func TestShapeInvokeTurnReadOnlyOnlyRestricts(t *testing.T) {
	reg := catalog.NewEventTriggerRegistry()
	reg.Upsert(catalog.NewEventTriggerDescriptor("writable", catalog.EventTriggerSpec{
		Target: catalog.EventTriggerTarget{AgentRef: "swe", PromptTemplate: "x"},
	}, true))

	shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("x"), ReadOnly: true}, "", "", "", reg, testCaller, time.Now())
	require.NoError(t, err)
	require.True(t, shaped.turn.ReadOnly)

	shaped, err = shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review"), ReadOnly: false}, "", "", "", reviewTriggers(t), testCaller, time.Now())
	require.NoError(t, err)
	require.True(t, shaped.turn.ReadOnly)
}

func TestShapeInvokeTurnRejectsAnEmptyRequestWithNothingToRun(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  invokeRequest
	}{
		{"nothing at all", invokeRequest{Request: ""}},
		{"whitespace", invokeRequest{Request: "   "}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := shapeInvokeTurn(tc.req, "", "", "", nil, testCaller, time.Now())
			require.ErrorIs(t, err, errEmptyRequest)
		})
	}
}

// TS always defaults link flow to "authcode", overridable per-request so a
// headless caller (integration-gateway's relay) with no browser to redirect
// can request "device" instead — a request property, not something inferred
// from Live/streaming. §5's snake_case spelling is accepted too.
func TestShapeInvokeTurnCarriesTheIdentityLinkFlowOverride(t *testing.T) {
	for _, req := range []invokeRequest{
		{Request: "triage this", IdentityLinkFlow: "device"},
		{Request: "triage this", IdentityLinkFlowSnake: "device"},
	} {
		shaped, err := shapeInvokeTurn(req, "", "", "", nil, testCaller, time.Now())
		require.NoError(t, err)
		require.Equal(t, "device", shaped.turn.IdentityLinkFlow)
	}
}

func TestShapeInvokeTurnDefaultsIdentityLinkFlowToEmpty(t *testing.T) {
	shaped, err := shapeInvokeTurn(invokeRequest{Request: "triage this"}, "", "", "", nil, testCaller, time.Now())
	require.NoError(t, err)
	require.Empty(t, shaped.turn.IdentityLinkFlow, "the workflow itself defaults an empty flow to authcode")
}

// A caller's session id is used when the matched trigger has no sessionKey;
// §5 spells it session_id, agent-orchestrator sessionId.
func TestShapeInvokeTurnCallerSessionID(t *testing.T) {
	reg := catalog.NewEventTriggerRegistry()
	reg.Upsert(catalog.NewEventTriggerDescriptor("t", catalog.EventTriggerSpec{
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "x"},
	}, true))

	shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("x"), SessionIDSnake: "caller-session"}, "", "", "", reg, testCaller, time.Now())
	require.NoError(t, err)
	require.Equal(t, "caller-session", shaped.sessionID)

	shaped, err = shapeInvokeTurn(invokeRequest{Event: prEnvelope("x")}, "", "", "", reg, testCaller, time.Now())
	require.NoError(t, err)
	require.Equal(t, "event:github:d-1", shaped.sessionID)
}

// The security core of ADR 0030 §6. The sender login selects the principal
// that credentials are keyed by, so with a secret configured it must come
// ONLY from a verified assertion — anything holding this endpoint's token
// could otherwise name an arbitrary login and be handed that person's
// credentials.
func TestShapeInvokeTurnSenderLoginTrust(t *testing.T) {
	now := time.UnixMilli(1754150400000)
	valid := rbac.MintSenderAssertion(assertionSecret, "imaustink", rbac.DefaultAssertionTTL, now)
	attacker := func() *catalog.Envelope {
		e := prEnvelope("ai-review")
		e.Sender = map[string]any{"login": "attacker"}
		return e
	}

	t.Run("with a secret, a verified assertion is trusted", func(t *testing.T) {
		shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, valid, "", assertionSecret, reviewTriggers(t), testCaller, now)
		require.NoError(t, err)
		require.Equal(t, "imaustink", shaped.turn.SenderLogin)
	})

	t.Run("with a secret, the unsigned envelope sender is ignored entirely", func(t *testing.T) {
		shaped, err := shapeInvokeTurn(invokeRequest{Event: attacker()}, "", "", assertionSecret, reviewTriggers(t), testCaller, now)
		require.NoError(t, err)
		require.Empty(t, shaped.turn.SenderLogin,
			"no assertion means no principal — never the login the body claimed")
	})

	t.Run("with a secret, the envelope cannot override a verified assertion", func(t *testing.T) {
		shaped, err := shapeInvokeTurn(invokeRequest{Event: attacker()}, valid, "", assertionSecret, reviewTriggers(t), testCaller, now)
		require.NoError(t, err)
		require.Equal(t, "imaustink", shaped.turn.SenderLogin)
	})

	t.Run("with a secret, an assertion signed by someone else is refused", func(t *testing.T) {
		forged := rbac.MintSenderAssertion("some-other-secret", "imaustink", rbac.DefaultAssertionTTL, now)
		shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, forged, "", assertionSecret, reviewTriggers(t), testCaller, now)
		require.NoError(t, err)
		require.Empty(t, shaped.turn.SenderLogin)
	})

	t.Run("with a secret, an expired assertion is refused", func(t *testing.T) {
		shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, valid, "", assertionSecret, reviewTriggers(t), testCaller,
			now.Add(rbac.DefaultAssertionTTL+time.Second))
		require.NoError(t, err)
		require.Empty(t, shaped.turn.SenderLogin)
	})

	// The documented weaker mode: upgrading a deployment must not silently
	// break it. Announced at startup by rbac.WarnIfSenderAssertionUnset.
	t.Run("without a secret, the envelope sender is trusted", func(t *testing.T) {
		shaped, err := shapeInvokeTurn(invokeRequest{Event: prEnvelope("ai-review")}, "", "", "", reviewTriggers(t), testCaller, now)
		require.NoError(t, err)
		require.Equal(t, "imaustink", shaped.turn.SenderLogin)
	})

	// The principal must resolve for a resolved turn too, which matches
	// nothing here — otherwise cross-entry-point credential sharing would
	// quietly depend on which side did the matching.
	t.Run("resolves for a resolved turn", func(t *testing.T) {
		dispatch := signedDispatch(rbac.Dispatch{TriggerName: "t", ForcedAgentID: "a"}, "", "r", now)
		shaped, err := shapeInvokeTurn(invokeRequest{Request: "r"}, valid, dispatch, assertionSecret, nil, testCaller, now)
		require.NoError(t, err)
		require.Equal(t, "imaustink", shaped.turn.SenderLogin)
	})
}

// §5's non-turn outcomes are answered before any workflow is touched: a nil
// Temporal client is the assertion, since reaching update-with-start would
// panic.
func TestHandleInvokeEventOutcomes(t *testing.T) {
	post := func(s *Server, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/invoke", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.Handler().ServeHTTP(rec, req)
		return rec
	}
	envelope := func(label string) string {
		raw, err := json.Marshal(map[string]any{"event": prEnvelope(label)})
		require.NoError(t, err)
		return string(raw)
	}

	s := NewServer(nil, "tq", nil, WithEventTriggers(reviewTriggers(t)))
	rec := post(s, envelope("bug"))
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"status":"ignored"}`, rec.Body.String())

	failing := catalog.NewEventTriggerRegistry()
	failing.Upsert(catalog.NewEventTriggerDescriptor("needs-issue", catalog.EventTriggerSpec{
		Params: map[string]string{"n": "body.issue.number"},
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "{{n}}"},
	}, true))
	rec = post(NewServer(nil, "tq", nil, WithEventTriggers(failing)), envelope("ai-review"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	var outcome invokeOutcome
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &outcome))
	require.Equal(t, "failed", outcome.Status)
	require.Contains(t, outcome.Error, "needs-issue")

	// No trigger table: ignored, exactly like LangGraph (§5).
	rec = post(NewServer(nil, "tq", nil), envelope("ai-review"))
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"status":"ignored"}`, rec.Body.String())

	// Dispatch in the body: refused before any workflow is touched.
	withForced, err := json.Marshal(map[string]any{"event": prEnvelope("ai-review"), "forcedAgentId": "claude-code-swe-agent"})
	require.NoError(t, err)
	rec = post(s, string(withForced))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	rec = post(s, `{"request":"push it","forcedAgentId":"claude-code-swe-agent","triggerName":"github-issue-triage"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// The 202 body's trigger.reply is null — present, not omitted — when the
// trigger declares no reply, so a consumer can tell "no side effects" from
// "an older gateway that never sends the field".
func TestInvokeAcceptedTriggerShape(t *testing.T) {
	raw, err := json.Marshal(invokeAccepted{
		ID: "w.u", Status: invokeStatusPending,
		Trigger: &invokeTrigger{Name: "t", SessionID: "event:ci:1"},
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"w.u","status":"pending","trigger":{"name":"t","sessionId":"event:ci:1","reply":null}}`, string(raw))

	raw, err = json.Marshal(invokeAccepted{ID: "w.u", Status: invokeStatusPending})
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"w.u","status":"pending"}`, string(raw))
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

// TS's chat-completions.ts openAiError shapes every 400 as
// {error:{message, type:"invalid_request_error", code:"invalid_request"}} so
// real OpenAI clients (ADR 0035 §3) can parse it; Go must match, not send
// {message, type:"durable_agents_error"} with no code.
func TestMalformedToolArrayErrorEnvelopeMatchesOpenAIShape(t *testing.T) {
	s := NewServer(nil, "tq", nil)

	body := `{"messages":[{"role":"user","content":"hi"}],
		"tools":[{"type":"function","function":{"name":"a"}},{"type":"function","function":{"name":"a"}}]}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	s.Handler().ServeHTTP(rec, req)

	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Equal(t, "invalid_request_error", parsed.Error.Type)
	require.Equal(t, "invalid_request", parsed.Error.Code)
	require.Contains(t, parsed.Error.Message, "duplicate")
}

func TestInvalidJSONBodyErrorEnvelopeMatchesOpenAIShape(t *testing.T) {
	s := NewServer(nil, "tq", nil)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	s.Handler().ServeHTTP(rec, req)

	var parsed struct {
		Error struct {
			Type string `json:"type"`
			Code string `json:"code"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Equal(t, "invalid_request_error", parsed.Error.Type)
	require.Equal(t, "invalid_request", parsed.Error.Code)
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
