package gateway

// Internal test: handleInvokeStatus is the /invoke poll endpoint
// agent-orchestrator drives for every bridged-agent turn. A fake
// client.Client (embedding the interface so only the two methods this
// handler calls need overriding) is enough to reach every branch without
// standing up Temporal.

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
)

// fakeTemporalClient overrides only what handleInvokeStatus calls; every
// other client.Client method panics if reached, which would fail the test
// loudly rather than silently doing the wrong thing.
type fakeTemporalClient struct {
	client.Client
	handle client.WorkflowUpdateHandle
}

func (f *fakeTemporalClient) GetWorkflowUpdateHandle(client.GetWorkflowUpdateHandleOptions) client.WorkflowUpdateHandle {
	return f.handle
}

func (f *fakeTemporalClient) QueryWorkflow(context.Context, string, string, string, ...interface{}) (converter.EncodedValue, error) {
	return nil, errors.New("no progress recorded in this test")
}

func invokeStatusRequest(t *testing.T, s *Server, invocationID string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Params = gin.Params{{Key: "id", Value: invocationID}}
	c.Request = httptest.NewRequest("GET", "/invoke/"+invocationID, nil)
	s.handleInvokeStatus(c)
	return rec
}

// The regression this exists for: the SDK's long-poll gRPC call getting
// cancelled or timing out on its own terms (surfacing as e.g. "stream
// terminated by RST_STREAM with error code: CANCEL") is NOT the update
// failing -- the SDK's own doc comment says so explicitly -- but reporting it
// as invokeStatusFailed made agent-orchestrator show a bridged coding agent's
// routine multi-minute turn as an outright failure while the AgentRun kept
// working in the background.
func TestHandleInvokeStatusTreatsTransportCancelAsPending(t *testing.T) {
	handle := &fakeUpdateHandle{errs: []error{
		client.NewWorkflowUpdateServiceTimeoutOrCanceledError(errors.New("stream terminated by RST_STREAM with error code: CANCEL")),
	}}
	s := NewServer(&fakeTemporalClient{handle: handle}, "task-queue", nil)

	rec := invokeStatusRequest(t, s, encodeInvocationID("conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))

	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{"id":"conversation-abc.6ba7b810-9dad-11d1-80b4-00c04fd430c8","status":"pending"}`, rec.Body.String())
}

// A genuinely failed update (the workflow rejected it, or the turn errored)
// must still surface as failed -- only the transport-cancellation shape is
// reclassified.
func TestHandleInvokeStatusReportsARealFailure(t *testing.T) {
	handle := &fakeUpdateHandle{errs: []error{errors.New("turn failed: launch_error")}}
	s := NewServer(&fakeTemporalClient{handle: handle}, "task-queue", nil)

	rec := invokeStatusRequest(t, s, encodeInvocationID("conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))

	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{"id":"conversation-abc.6ba7b810-9dad-11d1-80b4-00c04fd430c8","status":"failed","error":"turn failed: launch_error"}`, rec.Body.String())
}

// An id naming an update Temporal has never heard of (aged-out workflow, or a
// caller-forged id) is a 404, distinct from a turn that ran and failed.
func TestHandleInvokeStatusUnknownUpdateIs404(t *testing.T) {
	handle := &fakeUpdateHandle{errs: []error{serviceerror.NewNotFound("not found")}}
	s := NewServer(&fakeTemporalClient{handle: handle}, "task-queue", nil)

	rec := invokeStatusRequest(t, s, encodeInvocationID("conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))

	require.Equal(t, 404, rec.Code)
}

// A turn that succeeds on the very next poll (no transport hiccup at all)
// still reports normally -- the transport-cancel handling above must not
// swallow or delay an ordinary success.
func TestHandleInvokeStatusSucceededReportsTheReply(t *testing.T) {
	handle := &fakeUpdateHandle{reply: "Opened PR #42."}
	s := NewServer(&fakeTemporalClient{handle: handle}, "task-queue", nil)

	rec := invokeStatusRequest(t, s, encodeInvocationID("conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))

	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{
		"id":"conversation-abc.6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		"status":"succeeded",
		"result":"Opened PR #42."
	}`, rec.Body.String())
}

// A poller has no other way to tell "this turn parked on a still-outstanding
// account link" apart from "this turn is genuinely done" -- both are a
// "succeeded" record with a Reply. Path is that signal, and a caller that
// can wait on it (agent-orchestrator's TemporalEngine, for a live chat
// caller) reads it to decide whether to keep trying rather than surfacing
// the link prompt as if it were the final answer.
func TestHandleInvokeStatusSucceededSurfacesTheLinkRequiredPath(t *testing.T) {
	handle := &fakeUpdateHandle{reply: "To continue, please link your GitHub account...", path: "link-required"}
	s := NewServer(&fakeTemporalClient{handle: handle}, "task-queue", nil)

	rec := invokeStatusRequest(t, s, encodeInvocationID("conversation-abc", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))

	require.Equal(t, 200, rec.Code)
	require.JSONEq(t, `{
		"id":"conversation-abc.6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		"status":"succeeded",
		"result":"To continue, please link your GitHub account...",
		"path":"link-required"
	}`, rec.Body.String())
}
