package agentrun_test

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/aktisai/orchestrator/engines/temporal/internal/agentrun"
)

// docs/adr/0050 §3b: a pod agent's message stream becomes spans under the
// launching activity -- one agent_run span, a child per tool call closed by
// its result, progress and replies as events -- with no message text.
func TestABridgedRunBecomesSpansUnderItsLauncher(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })

	conn := newFakeConn()
	bridge := agentrun.NewBridge(conn, &fakeSignaler{}, "")
	ctx, launch := tp.Tracer("test").Start(context.Background(), "RunActivity:LaunchAgentRun")
	require.NoError(t, bridge.AttachTraced(ctx, runID, "wf-1", "swe"))
	subjects := agentrun.SubjectsFor(runID, "")

	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 1, Type: agentrun.UpProgress, Stage: "clone", Message: "SECRET narration"})
	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 2, Type: agentrun.UpToolCall, CallID: "c1", Tool: "github", Input: "SECRET input"})
	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 3, Type: agentrun.UpToolCall, CallID: "c2", Tool: "web-search", Input: "x"})
	require.NoError(t, bridge.ToolResult(runID, "c1", true, "SECRET output", ""))
	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 4, Type: agentrun.UpReply, Final: true, Message: "SECRET reply"})
	bridge.Detach(runID) // c2 never returned
	launch.End()

	byName := map[string]sdktrace.ReadOnlySpan{}
	for _, s := range rec.Ended() {
		byName[s.Name()] = s
	}
	run, tool1, tool2 := byName["agent_run swe"], byName["tool github"], byName["tool web-search"]
	require.NotNil(t, run)
	require.NotNil(t, tool1)
	require.NotNil(t, tool2)

	require.Equal(t, launch.SpanContext().SpanID(), run.Parent().SpanID(), "the run hangs off the launching activity")
	require.Equal(t, run.SpanContext().SpanID(), tool1.Parent().SpanID())
	require.Equal(t, codes.Unset, tool1.Status().Code)
	require.Equal(t, codes.Error, tool2.Status().Code, "a tool still open when the run ends is closed as failed")

	var events []string
	for _, e := range run.Events() {
		events = append(events, e.Name)
	}
	require.Equal(t, []string{"progress", "reply"}, events)

	for _, s := range rec.Ended() {
		for _, kv := range s.Attributes() {
			require.False(t, strings.Contains(kv.Value.Emit(), "SECRET"), "%s.%s leaks content", s.Name(), kv.Key)
		}
		for _, e := range s.Events() {
			for _, kv := range e.Attributes {
				require.False(t, strings.Contains(kv.Value.Emit(), "SECRET"), "%s event %s leaks content", s.Name(), e.Name)
			}
		}
	}
}

// Re-attaching after a worker restart has no trace context: no spans, and
// bridging works exactly as before.
func TestAnUntracedAttachMakesNoSpans(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	t.Cleanup(func() { otel.SetTracerProvider(prev) })

	conn := newFakeConn()
	bridge := agentrun.NewBridge(conn, &fakeSignaler{}, "")
	require.NoError(t, bridge.Attach(runID, "wf-1"))
	conn.deliver(t, agentrun.SubjectsFor(runID, "").Up, agentrun.UpMessage{AgentRunID: runID, Seq: 1, Type: agentrun.UpToolCall, CallID: "c1", Tool: "github"})
	bridge.Detach(runID)
	require.Empty(t, rec.Ended())
}
