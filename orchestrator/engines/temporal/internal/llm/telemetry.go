package llm

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/aktisai/orchestrator/engines/temporal/internal/telemetry"
)

// startGeneration opens a generation span for one model call (docs/adr/0050
// §3a). Metadata only -- model, operation, the structured schema's name, token
// usage. No prompt or completion text: content capture is a later, separately
// gated policy (§5), off by default.
func (c *Client) startGeneration(ctx context.Context, operation, schema string) (context.Context, trace.Span) {
	name := "llm." + operation
	if schema != "" {
		name += " " + schema
	}
	attrs := []attribute.KeyValue{
		attribute.String(telemetry.AttrGenAISystem, "openai"),
		attribute.String(telemetry.AttrGenAIOperation, operation),
		attribute.String(telemetry.AttrGenAIRequestModel, c.model),
		attribute.String(telemetry.AttrLangfuseObservationType, "generation"),
	}
	if schema != "" {
		attrs = append(attrs, attribute.String("aktis.llm.schema", schema))
	}
	return telemetry.Tracer().Start(ctx, name, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attrs...))
}

func recordUsage(span trace.Span, parsed chatResponse) {
	if parsed.Usage == nil {
		return
	}
	span.SetAttributes(
		attribute.Int(telemetry.AttrGenAIInputTokens, parsed.Usage.PromptTokens),
		attribute.Int(telemetry.AttrGenAIOutputTokens, parsed.Usage.CompletionTokens),
	)
}

func endGeneration(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}
