package agentrun

import (
	"context"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/aktisai/orchestrator/engines/temporal/internal/telemetry"
)

// runTrace turns one pod agent's message stream into spans (docs/adr/0050
// §3b): an agent_run span under the activity that launched it, a child span
// per tool call (closed by the tool_result going back down), and progress,
// warnings and replies as span events. The bridge is the one place outside
// workflow code that sees every up-message, so spans are made here and never
// in a workflow, which must stay deterministic.
//
// Metadata only: message text, tool input and tool output are never recorded
// (content capture is a separate, off-by-default policy, §5).
type runTrace struct {
	mu    sync.Mutex
	span  trace.Span
	tools map[string]trace.Span // callID -> open tool span
	ended bool
}

func startRunTrace(parent context.Context, agentRunID, agentRef string) *runTrace {
	_, span := telemetry.Tracer().Start(parent, "agent_run "+agentRef, trace.WithAttributes(
		attribute.String("aktis.agent", agentRef),
		attribute.String("aktis.agent_run", agentRunID),
		attribute.String("langfuse.observation.type", "agent"),
	))
	return &runTrace{span: span, tools: map[string]trace.Span{}}
}

func (t *runTrace) up(msg UpMessage) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ended {
		return
	}
	switch msg.Type {
	case UpToolCall:
		ctx := trace.ContextWithSpan(context.Background(), t.span)
		_, span := telemetry.Tracer().Start(ctx, "tool "+msg.Tool, trace.WithAttributes(
			attribute.String("aktis.tool", msg.Tool),
			attribute.String("aktis.tool_call_id", msg.CallID),
			attribute.String("langfuse.observation.type", "tool"),
		))
		t.tools[msg.CallID] = span
	case UpProgress, UpWarning:
		attrs := []attribute.KeyValue{attribute.String("aktis.stage", msg.Stage)}
		if msg.Pct != nil {
			attrs = append(attrs, attribute.Float64("aktis.pct", *msg.Pct))
		}
		t.span.AddEvent(msg.Type, trace.WithAttributes(attrs...))
	case UpReply:
		t.span.AddEvent("reply", trace.WithAttributes(attribute.Bool("aktis.final", msg.Final)))
	case UpFailed:
		t.span.SetStatus(codes.Error, msg.Code)
		t.span.AddEvent("failed", trace.WithAttributes(attribute.String("aktis.code", msg.Code)))
	}
}

func (t *runTrace) toolResult(callID string, ok bool, errText string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	span, open := t.tools[callID]
	if !open {
		return
	}
	delete(t.tools, callID)
	span.SetAttributes(attribute.Bool("aktis.ok", ok))
	if !ok {
		// The error class, not its text: tool errors can echo input.
		span.SetStatus(codes.Error, "tool failed")
	}
	span.End()
}

func (t *runTrace) end() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ended {
		return
	}
	t.ended = true
	for id, span := range t.tools {
		span.SetStatus(codes.Error, "run ended before the tool returned")
		span.End()
		delete(t.tools, id)
	}
	t.span.End()
}
