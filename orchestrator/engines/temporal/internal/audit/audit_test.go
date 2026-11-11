package audit_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
)

func TestEntryPoint(t *testing.T) {
	require.Equal(t, audit.EntryWebhook, audit.EntryPoint(false, "ai-triage", "alice"))
	require.Equal(t, audit.EntryEvent, audit.EntryPoint(false, "nightly-sweep", ""))
	require.Equal(t, audit.EntryChat, audit.EntryPoint(true, "", ""))
	require.Equal(t, audit.EntryAPI, audit.EntryPoint(false, "", ""))
}

// One JSON object per line, flattened, timestamped in UTC.
func TestEmitWritesOneJSONLinePerRecord(t *testing.T) {
	var buf bytes.Buffer
	restore := audit.SetOutput(&buf, func() time.Time { return time.Date(2026, 11, 11, 12, 0, 0, 0, time.FixedZone("x", 3600)) })
	defer restore()

	audit.Emit(audit.Record{Kind: audit.KindAuthorization, Agent: "swe", Outcome: "authorized",
		Launch: audit.Launch{DecisionID: "r/1", LaunchedBy: "openwebui:1", IdentityMode: "agent"}})
	audit.Emit(audit.Record{Kind: audit.KindLaunch, Agent: "swe", AgentRun: "agentrun-swe-1", Outcome: "launched"})

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	require.Len(t, lines, 2)
	var first map[string]any
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &first))
	require.Equal(t, "agent-authorization", first["kind"])
	require.Equal(t, "2026-11-11T11:00:00Z", first["time"])
	require.Equal(t, "openwebui:1", first["launchedBy"], "launch fields are flattened into the record")
	require.Equal(t, "agent", first["identityMode"])
	require.NotContains(t, lines[1], "launchedBy", "empty fields are omitted")
}
