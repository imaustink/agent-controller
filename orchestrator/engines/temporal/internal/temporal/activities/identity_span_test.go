package activities

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
)

// docs/adr/0050 §1: the audit record carries the trace it ran in, and the
// span carries the audit record's identity -- each finds the other.
func TestAuditAndTraceJoinBothWays(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	ctx, span := tp.Tracer("t").Start(context.Background(), "RunActivity:Authorize")

	traceID, traceparent := traceOf(ctx)
	require.Equal(t, span.SpanContext().TraceID().String(), traceID)
	require.Regexp(t, `^00-`+traceID+`-[0-9a-f]{16}-01$`, traceparent)

	launch := audit.Launch{
		EntryPoint: audit.EntryWebhook, LaunchedBy: "svc:integration-gateway",
		DelegatedSubject: "openwebui:alice", Sender: &audit.Sender{Provider: "github", Login: "alice"},
		Trigger: "triage", IdentityMode: "hybrid", IdentityModeSource: "trigger", TraceID: traceID,
	}
	annotateIdentity(ctx, launch, "conversation-github-acme-1")
	span.End()

	attrs := map[string]any{}
	for _, kv := range rec.Ended()[0].Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsInterface()
	}
	require.Equal(t, "openwebui:alice", attrs["langfuse.user.id"], "the human the run acted for")
	require.Equal(t, "svc:integration-gateway", attrs["aktis.launched_by"])
	require.Equal(t, "conversation-github-acme-1", attrs["langfuse.session.id"])
	require.Equal(t, []string{"identity:hybrid", "entry:webhook"}, attrs["langfuse.trace.tags"])
	require.Equal(t, "github:alice", attrs["aktis.sender"])

	// No tracer: no trace fields, nothing to join.
	id, tp2 := traceOf(context.Background())
	require.Empty(t, id)
	require.Empty(t, tp2)
}

// The trace user is the human acted for, never the shared relay identity
// when there is anyone better.
func TestTraceUser(t *testing.T) {
	require.Equal(t, "openwebui:a", TraceUser(audit.Launch{DelegatedSubject: "openwebui:a", LaunchedBy: "svc"}))
	require.Equal(t, "github:alice", TraceUser(audit.Launch{Sender: &audit.Sender{Login: "alice"}, LaunchedBy: "svc"}))
	require.Equal(t, "openwebui:b", TraceUser(audit.Launch{LaunchedBy: "openwebui:b"}))
}
