package gateway_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/api/serviceerror"

	"github.com/controller-agent/temporal-engine/internal/gateway"
	"github.com/controller-agent/temporal-engine/internal/messaging"
)

type fakeSignaler struct {
	workflowID string
	signalName string
	event      messaging.Event
	calls      int
	err        error
}

func (f *fakeSignaler) SignalWorkflow(_ context.Context, workflowID, _ string, signalName string, arg any) error {
	f.calls++
	f.workflowID = workflowID
	f.signalName = signalName
	f.event = arg.(messaging.Event)
	return f.err
}

const testSecret = "cb-secret"

func post(t *testing.T, handler http.Handler, path string, body []byte, sign bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	if sign {
		req.Header.Set(messaging.SignatureHeader, messaging.Sign(testSecret, body))
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestCallbackDeliversSignal(t *testing.T) {
	signaler := &fakeSignaler{}
	handler := gateway.NewCallbackServer(signaler, testSecret).Handler()

	body := []byte(`{"job_id":"run-1","seq":2,"ts":"t","type":"succeeded","result":"done"}`)
	rec := post(t, handler, "/callback/conversation-abc/run-1", body, true)

	require.Equal(t, http.StatusAccepted, rec.Code)
	require.Equal(t, 1, signaler.calls)
	require.Equal(t, "conversation-abc", signaler.workflowID)
	require.Equal(t, "tool-event::run-1", signaler.signalName)
	require.Equal(t, "succeeded", signaler.event.Type)
}

func TestCallbackRejectsBadSignature(t *testing.T) {
	signaler := &fakeSignaler{}
	handler := gateway.NewCallbackServer(signaler, testSecret).Handler()
	body := []byte(`{"job_id":"run-1","seq":0,"ts":"t","type":"accepted"}`)

	rec := post(t, handler, "/callback/wf/run-1", body, false)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	req := httptest.NewRequest(http.MethodPost, "/callback/wf/run-1", bytes.NewReader(body))
	req.Header.Set(messaging.SignatureHeader, messaging.Sign("wrong-secret", body))
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req)
	require.Equal(t, http.StatusUnauthorized, rec2.Code)

	require.Zero(t, signaler.calls, "unsigned events must never reach a workflow")
}

func TestCallbackRejectsInvalidEvent(t *testing.T) {
	signaler := &fakeSignaler{}
	handler := gateway.NewCallbackServer(signaler, testSecret).Handler()
	rec := post(t, handler, "/callback/wf/run-1", []byte(`{"seq":0,"type":"exploded"}`), true)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Zero(t, signaler.calls)
}

func TestCallbackTrustsPathOverBodyJobID(t *testing.T) {
	signaler := &fakeSignaler{}
	handler := gateway.NewCallbackServer(signaler, testSecret).Handler()
	body := []byte(`{"job_id":"spoofed","seq":1,"ts":"t","type":"progress"}`)
	rec := post(t, handler, "/callback/wf/run-real", body, true)

	require.Equal(t, http.StatusAccepted, rec.Code)
	require.Equal(t, "tool-event::run-real", signaler.signalName)
	require.Equal(t, "run-real", signaler.event.JobID, "body job_id must be overridden by path")
}

func TestCallbackGoneWhenWorkflowMissing(t *testing.T) {
	signaler := &fakeSignaler{err: serviceerror.NewNotFound("no workflow")}
	handler := gateway.NewCallbackServer(signaler, testSecret).Handler()
	body := []byte(`{"job_id":"run-1","seq":3,"ts":"t","type":"progress"}`)
	rec := post(t, handler, "/callback/wf-done/run-1", body, true)
	require.Equal(t, http.StatusGone, rec.Code)
}
