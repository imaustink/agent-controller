package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func recordSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	t.Cleanup(func() { otel.SetTracerProvider(prev) })
	return rec
}

// docs/adr/0050 §3a/§5: one generation span per model call, carrying model and
// token usage -- and NO prompt or completion text, which is off by default.
func TestCompleteRecordsAGenerationSpanWithUsageAndNoContent(t *testing.T) {
	rec := recordSpans(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"SECRET-COMPLETION"}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}`))
	}))
	defer srv.Close()

	out, err := New(srv.URL, "sk-test", "gpt-test").Complete(context.Background(), []Message{{Role: "user", Content: "SECRET-PROMPT"}})
	require.NoError(t, err)
	require.Equal(t, "SECRET-COMPLETION", out)

	spans := rec.Ended()
	require.Len(t, spans, 1)
	s := spans[0]
	require.Equal(t, "llm.chat", s.Name())
	attrs := map[string]any{}
	for _, kv := range s.Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsInterface()
	}
	require.Equal(t, "gpt-test", attrs["gen_ai.request.model"])
	require.Equal(t, int64(12), attrs["gen_ai.usage.input_tokens"])
	require.Equal(t, int64(5), attrs["gen_ai.usage.output_tokens"])
	require.Equal(t, "generation", attrs["langfuse.observation.type"])
	for k, v := range attrs {
		str, _ := v.(string)
		require.False(t, strings.Contains(str, "SECRET") || strings.Contains(str, "sk-test"), "attribute %s leaks content: %q", k, str)
	}
}

func TestAFailedCallMarksItsSpanAsAnError(t *testing.T) {
	rec := recordSpans(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "k", "m").CompleteJSON(context.Background(), nil, ResponseSchema{Name: "plan_action", Schema: []byte(`{}`)})
	require.Error(t, err)
	spans := rec.Ended()
	require.Len(t, spans, 1)
	require.Equal(t, "llm.chat plan_action", spans[0].Name())
	require.Equal(t, codes.Error, spans[0].Status().Code)
}
