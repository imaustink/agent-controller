package activities

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The platform ceiling can only tighten (docs/adr/0050 §5).
func TestContentCaptureCeiling(t *testing.T) {
	require.Equal(t, "content", contentCapture("content", true))
	require.Equal(t, "metadata", contentCapture("content", false), "ineligible run")
	require.Equal(t, "metadata", contentCapture("metadata", true), "ceiling")
	require.Equal(t, "metadata", contentCapture("", true), "unset ceiling is metadata")
	require.Equal(t, "metadata", contentCapture("everything", true), "unknown ceiling is metadata")
}
