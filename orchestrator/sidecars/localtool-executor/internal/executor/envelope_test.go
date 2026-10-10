package executor

import (
	"encoding/json"
	"testing"
)

func TestExtractEnvelope(t *testing.T) {
	t.Run("whole-body succeeded", func(t *testing.T) {
		env, ok := extractEnvelope([]byte(`{"type":"succeeded","result":{"a":1}}`))
		if !ok || env.Type != "succeeded" {
			t.Fatalf("got %+v ok=%v", env, ok)
		}
		var result map[string]int
		if err := json.Unmarshal(env.Result, &result); err != nil || result["a"] != 1 {
			t.Fatalf("bad result: %v %v", result, err)
		}
	})

	t.Run("trailing envelope among diagnostic lines", func(t *testing.T) {
		out := "installing deps...\nsome log line\n{\"type\":\"failed\",\"code\":\"http_error\",\"message\":\"boom\"}\n"
		env, ok := extractEnvelope([]byte(out))
		if !ok || env.Type != "failed" || env.Code != "http_error" {
			t.Fatalf("got %+v ok=%v", env, ok)
		}
	})

	t.Run("no envelope", func(t *testing.T) {
		if _, ok := extractEnvelope([]byte("just logs\nno json here")); ok {
			t.Fatal("expected ok=false")
		}
	})

	t.Run("json without recognized type is not an envelope", func(t *testing.T) {
		if _, ok := extractEnvelope([]byte(`{"foo":"bar"}`)); ok {
			t.Fatal("expected ok=false")
		}
	})

	t.Run("fallback yields a failed envelope", func(t *testing.T) {
		env := extractEnvelopeOrFail([]byte("nothing"))
		if env.Type != "failed" || env.Code != "bad_output" {
			t.Fatalf("got %+v", env)
		}
	})
}
