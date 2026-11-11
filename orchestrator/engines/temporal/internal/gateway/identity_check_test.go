package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.temporal.io/sdk/client"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/rbac"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/workflows"
)

// identityCheckClient answers the accept-phase IdentityCheckWorkflow with a
// fixed verdict and records what it was asked. Every other client.Client
// method panics if reached -- in particular UpdateWithStartWorkflow, which is
// how these tests prove a refused /invoke started NOTHING.
type identityCheckClient struct {
	client.Client
	answer   *authz.IdentityError
	startErr error
	inputs   []workflows.IdentityCheckInput
}

func (f *identityCheckClient) ExecuteWorkflow(_ context.Context, _ client.StartWorkflowOptions, name interface{}, args ...interface{}) (client.WorkflowRun, error) {
	if name != workflows.IdentityCheckWorkflowName {
		panic("unexpected workflow " + name.(string))
	}
	if f.startErr != nil {
		return nil, f.startErr
	}
	f.inputs = append(f.inputs, args[0].(workflows.IdentityCheckInput))
	return &identityCheckRun{answer: f.answer}, nil
}

type identityCheckRun struct {
	client.WorkflowRun
	answer *authz.IdentityError
}

func (r *identityCheckRun) Get(_ context.Context, valuePtr interface{}) error {
	*(valuePtr.(**authz.IdentityError)) = r.answer
	return nil
}

var linkRequired = &authz.IdentityError{Code: authz.CodeIdentityLinkRequired, Message: "alice: link your GitHub account"}

// A trigger turn agent-orchestrator matched: signed dispatch naming the agent,
// signed sender claims.
func postCheck(t *testing.T, s *Server, path string, claims rbac.SenderClaims) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	now := time.Now()
	body, _ := json.Marshal(invokeRequest{Request: "triage #1", SessionID: "s"})
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set(rbac.DispatchAssertionHeader, rbac.MintDispatchAssertion(assertionSecret,
		rbac.Dispatch{TriggerName: "triage", ForcedAgentID: "swe", Identity: "delegated"}, "s", "triage #1", rbac.DefaultAssertionTTL, now))
	if claims.Login != "" {
		req.Header.Set(rbac.SenderAssertionHeader, rbac.MintSenderClaims(assertionSecret, claims, rbac.DefaultAssertionTTL, now))
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestInvokeCheckAnswers403WithTheIdentityError(t *testing.T) {
	fake := &identityCheckClient{answer: linkRequired}
	s := NewServer(fake, "q", nil, WithSenderAssertionSecret(assertionSecret))

	rec := postCheck(t, s, "/invoke/check", rbac.SenderClaims{Login: "alice", AccountID: "583231", SubjectStatus: rbac.SenderSubjectUnlinked})
	require.Equal(t, http.StatusForbidden, rec.Code)
	var body struct {
		Status string                 `json:"status"`
		Error  map[string]interface{} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "failed", body.Status)
	require.Equal(t, authz.CodeIdentityLinkRequired, body.Error["code"])
	require.Equal(t, "alice: link your GitHub account", body.Error["message"])

	require.Len(t, fake.inputs, 1)
	in := fake.inputs[0]
	require.Equal(t, "swe", in.AgentID)
	require.Equal(t, "delegated", in.IdentityOverride, "the SIGNED override reaches the check")
	require.Equal(t, "alice", in.SenderLogin)
	require.Equal(t, "583231", in.SenderAccountID)
	require.Equal(t, rbac.SenderSubjectUnlinked, in.SenderSubjectStatus)
}

func TestInvokeCheckHasNoObjectionWhenItCannotDecide(t *testing.T) {
	for name, fake := range map[string]*identityCheckClient{
		"no objection": {answer: nil},
		"cannot start": {startErr: errors.New("temporal down")},
	} {
		s := NewServer(fake, "q", nil, WithSenderAssertionSecret(assertionSecret))
		rec := postCheck(t, s, "/invoke/check", rbac.SenderClaims{Login: "alice", SubjectStatus: rbac.SenderSubjectUnlinked})
		require.Equal(t, http.StatusNoContent, rec.Code, name)
	}

	// No sender at all (a cron trigger): never checked, nobody to resolve.
	fake := &identityCheckClient{answer: linkRequired}
	s := NewServer(fake, "q", nil, WithSenderAssertionSecret(assertionSecret))
	require.Equal(t, http.StatusNoContent, postCheck(t, s, "/invoke/check", rbac.SenderClaims{}).Code)
	require.Empty(t, fake.inputs)
}

// /invoke itself refuses before starting anything: the fake panics on
// UpdateWithStartWorkflow, so reaching it would fail this test.
func TestInvokeRefusesAnUnresolvableSenderBeforeStartingTheTurn(t *testing.T) {
	fake := &identityCheckClient{answer: linkRequired}
	s := NewServer(fake, "q", nil, WithSenderAssertionSecret(assertionSecret))
	rec := postCheck(t, s, "/invoke", rbac.SenderClaims{Login: "alice", SubjectStatus: rbac.SenderSubjectUnlinked})
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), authz.CodeIdentityLinkRequired)
}

// docs/adr/0050 §4: the refused request's span ends in error with the code.
func TestARefusedDeliveryEndsInAnErrorSpan(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	t.Cleanup(func() { otel.SetTracerProvider(prev) })

	s := NewServer(&identityCheckClient{answer: &authz.IdentityError{
		Code: authz.CodeIdentityLinkRequired, Message: "m", Target: &authz.IdentityTarget{Kind: "agent", Name: "swe"},
	}}, "q", nil, WithSenderAssertionSecret(assertionSecret))
	require.Equal(t, http.StatusForbidden, postCheck(t, s, "/invoke/check", rbac.SenderClaims{Login: "alice", SubjectStatus: rbac.SenderSubjectUnlinked}).Code)

	spans := rec.Ended()
	require.Len(t, spans, 1)
	require.Equal(t, codes.Error, spans[0].Status().Code)
	require.Equal(t, authz.CodeIdentityLinkRequired, spans[0].Status().Description)
}
