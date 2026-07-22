package messaging_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/messaging"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	body := []byte(`{"job_id":"j1","seq":0,"ts":"2026-01-01T00:00:00Z","type":"accepted"}`)
	sig := messaging.Sign("secret", body)
	require.Regexp(t, `^sha256=[0-9a-f]{64}$`, sig)
	require.NoError(t, messaging.Verify("secret", body, sig))
	require.Error(t, messaging.Verify("wrong-secret", body, sig))
	require.Error(t, messaging.Verify("secret", []byte("tampered"), sig))
	require.Error(t, messaging.Verify("secret", body, "sha256=zzz"))
	require.Error(t, messaging.Verify("secret", body, ""))
	require.Error(t, messaging.Verify("", body, sig), "empty secret must fail closed")
}

// Signature must match what @controller-agent/messaging's CallbackSink
// produces (createHmac("sha256", secret).update(body).digest("hex")).
func TestSignMatchesUpstreamVector(t *testing.T) {
	// printf '%s' 'hello' | openssl dgst -sha256 -hmac 'key'
	require.Equal(t,
		"sha256=9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b",
		messaging.Sign("key", []byte("hello")))
}

func TestParseEvent(t *testing.T) {
	t.Run("succeeded", func(t *testing.T) {
		e, err := messaging.ParseEvent([]byte(`{
			"job_id":"j1","seq":2,"ts":"2026-01-01T00:00:00Z",
			"type":"succeeded","result":"# Recipe\nDone.",
			"artifacts":[{"uri":"s3://b/k","sha256":"abc","bytes":10,"content_type":"text/plain"}]
		}`))
		require.NoError(t, err)
		require.True(t, e.Terminal())
		require.Equal(t, "# Recipe\nDone.", e.ResultText())
		require.Len(t, e.Artifacts, 1)
	})

	t.Run("structured result stays JSON", func(t *testing.T) {
		e, err := messaging.ParseEvent([]byte(`{"job_id":"j1","seq":1,"ts":"t","type":"succeeded","result":{"slug":"pasta"}}`))
		require.NoError(t, err)
		require.JSONEq(t, `{"slug":"pasta"}`, e.ResultText())
	})

	t.Run("progress is non-terminal", func(t *testing.T) {
		e, err := messaging.ParseEvent([]byte(`{"job_id":"j1","seq":1,"ts":"t","type":"progress","stage":"extract","pct":40}`))
		require.NoError(t, err)
		require.False(t, e.Terminal())
	})

	t.Run("failed requires code and message", func(t *testing.T) {
		_, err := messaging.ParseEvent([]byte(`{"job_id":"j1","seq":1,"ts":"t","type":"failed","code":"blocked_url"}`))
		require.Error(t, err)
	})

	t.Run("unknown type rejected", func(t *testing.T) {
		_, err := messaging.ParseEvent([]byte(`{"job_id":"j1","seq":1,"ts":"t","type":"exploded"}`))
		require.Error(t, err)
	})

	t.Run("missing job_id rejected", func(t *testing.T) {
		_, err := messaging.ParseEvent([]byte(`{"seq":1,"ts":"t","type":"accepted"}`))
		require.Error(t, err)
	})
}
