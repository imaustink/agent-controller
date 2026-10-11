package continuation_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/continuation"
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

func TestResolveKey(t *testing.T) {
	tool := "recipe-publisher"

	t.Run("explicit instanceKey always wins", func(t *testing.T) {
		require.Equal(t, tool+"::https://x/r1",
			continuation.ResolveKey(tool, "https://x/r1", map[string]string{tool + "::https://x/other": "tok"}))
	})

	t.Run("bare tool id on the first call (no state)", func(t *testing.T) {
		require.Equal(t, tool, continuation.ResolveKey(tool, "", nil))
	})

	t.Run("recovers the single active instance from state", func(t *testing.T) {
		require.Equal(t, tool+"::https://x/r1",
			continuation.ResolveKey(tool, "", map[string]string{tool + "::https://x/r1": "tok"}))
	})

	t.Run("recovers a bare-keyed single instance from state", func(t *testing.T) {
		require.Equal(t, tool, continuation.ResolveKey(tool, "", map[string]string{tool: "tok"}))
	})

	t.Run("falls back to the bare id when two instances are ambiguous", func(t *testing.T) {
		require.Equal(t, tool, continuation.ResolveKey(tool, "", map[string]string{
			tool + "::https://x/r1": "a",
			tool + "::https://x/r2": "b",
		}))
	})

	t.Run("ignores other tools' continuation entries", func(t *testing.T) {
		require.Equal(t, tool, continuation.ResolveKey(tool, "", map[string]string{"image-gen::img1": "tok"}))
	})
}
