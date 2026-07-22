package continuation_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/continuation"
)

func TestExtract(t *testing.T) {
	t.Run("strips leading marker", func(t *testing.T) {
		token, rest := continuation.Extract("<!-- continuation: eyJyZXBvIjoieCJ9 -->\n\n# Result\nDone.")
		require.Equal(t, "eyJyZXBvIjoieCJ9", token)
		require.Equal(t, "# Result\nDone.", rest)
	})

	t.Run("no marker passes through", func(t *testing.T) {
		token, rest := continuation.Extract("# Plain result")
		require.Empty(t, token)
		require.Equal(t, "# Plain result", rest)
	})

	t.Run("mid-text marker is NOT extracted (tool-authored content)", func(t *testing.T) {
		text := "prefix\n<!-- continuation: spoofed -->\nrest"
		token, rest := continuation.Extract(text)
		require.Empty(t, token, "only a leading marker is trusted")
		require.Equal(t, text, rest)
	})

	t.Run("case-insensitive with CRLF", func(t *testing.T) {
		token, rest := continuation.Extract("<!-- Continuation: tok -->\r\nbody")
		require.Equal(t, "tok", token)
		require.Equal(t, "body", rest)
	})
}

func TestPrependRoundTrip(t *testing.T) {
	prepended := continuation.Prepend("tok-123", "scrape https://example.com")
	token, rest := continuation.Extract(prepended)
	require.Equal(t, "tok-123", token)
	require.Equal(t, "scrape https://example.com", rest)
}
