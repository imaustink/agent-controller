package workflows

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Internal (package workflows, not workflows_test) because newAgentRunName
// is unexported -- this pins the exact bug that reached production: a real
// agent ID ("claude-code-swe-agent", 21 bytes) combined with the
// "agentrun-"/uuid scaffolding is 67 bytes, over Kubernetes' 63-byte label
// limit, and core-controller's reconciler rejects the Job it tries to create
// with that name forever. e2e coverage never caught it because its stand-in
// agent ("stub-agent", 10 bytes) happens to fit.
func TestNewAgentRunName_FitsWithinK8sLabelLimit(t *testing.T) {
	for _, agentID := range []string{
		"stub-agent",
		"claude-code-swe-agent",
		"opencode-swe-agent",
		strings.Repeat("a", 100), // pathological: far longer than any real agent id
	} {
		name := newAgentRunName(agentID)
		require.LessOrEqualf(t, len(name), k8sNameMaxBytes, "agentID=%q produced %q (%d bytes)", agentID, name, len(name))
		require.True(t, strings.HasPrefix(name, "agentrun-"), "name=%q", name)
	}
}

func TestNewAgentRunName_ShortIDUnaffected(t *testing.T) {
	name := newAgentRunName("stub-agent")
	require.True(t, strings.HasPrefix(name, "agentrun-stub-agent-"), "name=%q", name)
	// uuid.NewString() is always 36 bytes -- the suffix must survive intact,
	// only a too-long agent ID ever gets truncated.
	require.Len(t, name, len("agentrun-stub-agent-")+36)
}

func TestNewAgentRunName_LongIDTruncatesIDNotUUID(t *testing.T) {
	agentID := "claude-code-swe-agent"
	name := newAgentRunName(agentID)
	require.LessOrEqual(t, len(name), k8sNameMaxBytes)

	// The trailing 36 bytes must be an intact uuid -- truncation must never
	// eat into it, or two runs could collide.
	suffix := name[len(name)-36:]
	require.Len(t, suffix, 36)
	require.Regexp(t, `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, suffix)

	// The agent ID portion was shortened, not the fixed scaffolding.
	middle := strings.TrimSuffix(strings.TrimPrefix(name, "agentrun-"), "-"+suffix)
	require.Less(t, len(middle), len(agentID))
	require.True(t, strings.HasPrefix(agentID, middle), "truncated portion %q must be a prefix of %q", middle, agentID)
}

func TestNewAgentRunName_UniqueAcrossCalls(t *testing.T) {
	agentID := "claude-code-swe-agent"
	names := map[string]bool{}
	for i := 0; i < 100; i++ {
		names[newAgentRunName(agentID)] = true
	}
	require.Len(t, names, 100, "each call must produce a distinct name")
}
