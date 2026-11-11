// Package telemetry sets up OpenTelemetry tracing for the engine (docs/adr/
// 0050). Traces go to the in-cluster collector named by
// OTEL_EXPORTER_OTLP_ENDPOINT; with it unset, everything here is a no-op and
// nothing is exported anywhere.
//
// Tracing is best effort by design: the exporter is batched and bounded, so an
// unreachable collector drops spans and never slows or fails a turn. It is NOT
// the audit trail -- internal/audit writes that unconditionally.
package telemetry

import (
	"context"
	"log"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// TracerName is the instrumentation scope for the engine's own spans.
const TracerName = "github.com/aktisai/orchestrator/engines/temporal"

// Enabled reports whether an OTLP endpoint is configured.
func Enabled() bool { return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" }

// Setup installs the global tracer provider and W3C propagator. It returns a
// shutdown func that flushes what is buffered (bounded by ctx). Without an
// endpoint it installs only the propagator, so trace context still flows
// across hops for whoever downstream does export.
func Setup(ctx context.Context, serviceName string) func(context.Context) error {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	if !Enabled() {
		return func(context.Context) error { return nil }
	}
	exporter, err := otlptracehttp.New(ctx) // reads OTEL_EXPORTER_OTLP_* itself
	if err != nil {
		log.Printf("[telemetry] tracing disabled: %v", err)
		return func(context.Context) error { return nil }
	}
	if name := os.Getenv("OTEL_SERVICE_NAME"); name != "" {
		serviceName = name
	}
	res, _ := resource.Merge(resource.Default(), resource.NewSchemaless(attribute.String("service.name", serviceName)))
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		// Bounded queue, never blocking: a full queue drops spans.
		sdktrace.WithBatcher(exporter,
			sdktrace.WithMaxQueueSize(4096),
			sdktrace.WithBatchTimeout(2*time.Second),
		),
	)
	otel.SetTracerProvider(tp)
	log.Printf("[telemetry] exporting traces as %s", serviceName)
	return tp.Shutdown
}

// Tracer is the engine's tracer (the global provider's; a no-op until Setup).
func Tracer() trace.Tracer { return otel.Tracer(TracerName) }

// Generation attributes, after the OpenTelemetry GenAI semantic conventions.
const (
	AttrGenAISystem       = "gen_ai.system"
	AttrGenAIOperation    = "gen_ai.operation.name"
	AttrGenAIRequestModel = "gen_ai.request.model"
	AttrGenAIInputTokens  = "gen_ai.usage.input_tokens"
	AttrGenAIOutputTokens = "gen_ai.usage.output_tokens"
	// AttrLangfuseObservationType makes Langfuse render a span as a
	// generation (model, usage, cost) rather than a plain span.
	AttrLangfuseObservationType = "langfuse.observation.type"
)
