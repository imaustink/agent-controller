package gateway

// Internal test: awaitTurnResult is the difference between a long agent turn
// succeeding and reporting failure, and it is reachable without standing up
// Temporal — a fake handle is enough to drive every branch.

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"

	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

// fakeUpdateHandle returns the queued errors in order, then succeeds with reply.
type fakeUpdateHandle struct {
	client.WorkflowUpdateHandle
	errs  []error
	reply string
	calls int
	// onCall runs before each result is returned, so a test can cancel the
	// context mid-flight the way a disconnecting client would.
	onCall func(call int)
}

func (f *fakeUpdateHandle) Get(_ context.Context, valuePtr interface{}) error {
	f.calls++
	if f.onCall != nil {
		f.onCall(f.calls)
	}
	if len(f.errs) > 0 {
		err := f.errs[0]
		f.errs = f.errs[1:]
		return err
	}
	if out, ok := valuePtr.(*workflows.TurnResult); ok {
		out.Reply = f.reply
	}
	return nil
}

func pollTimeout() error {
	// Mirrors what the SDK surfaces when its 60s client-side poll window closes
	// while the update is still running.
	return client.NewWorkflowUpdateServiceTimeoutOrCanceledError(errors.New("context deadline exceeded"))
}

// The regression this exists for: one poll window closing must not be reported
// as a failed turn. A bridged coding agent routinely outruns the window.
func TestAwaitTurnResultRetriesPastPollWindow(t *testing.T) {
	h := &fakeUpdateHandle{errs: []error{pollTimeout(), pollTimeout()}, reply: "done"}

	var result workflows.TurnResult
	require.NoError(t, awaitTurnResult(context.Background(), h, &result))
	require.Equal(t, "done", result.Reply)
	require.Equal(t, 3, h.calls, "should re-poll after each timeout, then return the result")
}

// A real update failure must surface immediately rather than being retried —
// otherwise a genuinely broken turn hangs until the client gives up.
func TestAwaitTurnResultReturnsRealErrors(t *testing.T) {
	boom := errors.New("workflow update rejected")
	h := &fakeUpdateHandle{errs: []error{boom}}

	var result workflows.TurnResult
	err := awaitTurnResult(context.Background(), h, &result)
	require.ErrorIs(t, err, boom)
	require.Equal(t, 1, h.calls, "a non-poll error must not be retried")
}

// The SDK returns the SAME error type when the caller's context is done, so the
// loop has to check ctx or it spins forever on a disconnected client.
func TestAwaitTurnResultStopsWhenCallerGoesAway(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	h := &fakeUpdateHandle{
		errs:   []error{pollTimeout(), pollTimeout()},
		reply:  "unreachable",
		onCall: func(call int) { cancel() }, // client hangs up during the first poll
	}

	var result workflows.TurnResult
	err := awaitTurnResult(ctx, h, &result)

	var pollErr *client.WorkflowUpdateServiceTimeoutOrCanceledError
	require.ErrorAs(t, err, &pollErr)
	require.Equal(t, 1, h.calls, "must not keep polling once the caller is gone")
}
