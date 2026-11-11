package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// docs/adr/0050 §4: a request arriving with a W3C traceparent (from
// agent-orchestrator, and integration-gateway before it) continues THAT
// trace, so a webhook delivery and the turn it starts are one trace.
// Health checks are not traced.
func TestTheGatewayContinuesAnInboundTraceparent(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	prevTP, prevProp := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTracerProvider(prevTP); otel.SetTextMapPropagator(prevProp) })

	s := NewServer(nil, "q", nil)
	h := s.Handler()

	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequest(http.MethodGet, "/invoke/conversation-x.upd-1", nil)
	req.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
	h.ServeHTTP(httptest.NewRecorder(), req)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	spans := rec.Ended()
	require.Len(t, spans, 1, "one span for /invoke/:id, none for /healthz")
	require.Equal(t, traceID, spans[0].SpanContext().TraceID().String())
	require.Equal(t, "GET /invoke/:id", spans[0].Name(), "ids are collapsed out of span names")
}
