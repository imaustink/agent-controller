package rbac

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Minted by agent-orchestrator's mintDispatchAssertion (src/rbac/
// dispatch-assertion.ts) with secret "cross-impl-secret" at 1754150400000ms:
// the TypeScript side mints, this side verifies, so the two must agree.
const tsDispatchVector = "eyJ0eXAiOiJkaXNwYXRjaCIsInRyaWdnZXJOYW1lIjoiZ2l0aHViLWlzc3VlLXRyaWFnZSIsImZvcmNlZEFnZW50SWQiOiJjbGF1ZGUtY29kZS1zd2UtYWdlbnQiLCJyZWFkT25seSI6dHJ1ZSwicGFyYW1zIjp7Im51bWJlciI6IjciLCJyZXBvc2l0b3J5IjoiYWNtZS93aWRnZXRzIn0sInNlc3Npb25JZCI6ImdpdGh1YjphY21lL3dpZGdldHMjNyIsInJlcXVlc3RTaGEyNTYiOiI4OTQ1NGJlM2Y2MDZhMWU3YzA0MDA4NThiYmNhZjE1NDViY2JmZDZjZjhjNDkyOTA4ODYyNjA5MmEyZGM2NWQwIiwiZXhwIjoxNzU0MTUwNzAwfQ.fQz5oFB-rkmppoC-OSXwG-28uIfIrkPRVqZsO95IF58"

func TestVerifyDispatchAssertionAcceptsTheTypeScriptMint(t *testing.T) {
	now := time.UnixMilli(1754150400000)
	d := VerifyDispatchAssertion("cross-impl-secret", tsDispatchVector, "github:acme/widgets#7", "Triage acme/widgets#7", now)
	require.NotNil(t, d)
	require.Equal(t, Dispatch{
		TriggerName:   "github-issue-triage",
		ForcedAgentID: "claude-code-swe-agent",
		ReadOnly:      true,
		Params:        map[string]string{"number": "7", "repository": "acme/widgets"},
	}, *d)

	require.Nil(t, VerifyDispatchAssertion("cross-impl-secret", tsDispatchVector, "github:acme/widgets#8", "Triage acme/widgets#7", now))
	require.Nil(t, VerifyDispatchAssertion("cross-impl-secret", tsDispatchVector, "github:acme/widgets#7", "Triage acme/widgets#8", now))
	require.Nil(t, VerifyDispatchAssertion("cross-impl-secret", tsDispatchVector, "github:acme/widgets#7", "Triage acme/widgets#7", now.Add(301*time.Second)))
}

func TestDispatchAssertionRoundTripAndTypeSeparation(t *testing.T) {
	now := time.Now()
	d := Dispatch{TriggerName: "t", ForcedToolID: "tool", ToolInput: "in"}
	minted := MintDispatchAssertion("s", d, "sess", "req", DefaultAssertionTTL, now)
	got := VerifyDispatchAssertion("s", minted, "sess", "req", now)
	require.NotNil(t, got)
	require.Equal(t, d, *got)

	// The same secret signs the identity assertions; none of them may be read
	// as another kind.
	require.Empty(t, VerifySenderAssertion("s", minted, now))
	subject, _, _ := VerifyCallerIdentityAssertion("s", minted, now)
	require.Empty(t, subject)
	require.Nil(t, VerifyDispatchAssertion("s", MintSenderAssertion("s", "login", DefaultAssertionTTL, now), "sess", "req", now))
	require.Nil(t, VerifyDispatchAssertion("s", MintCallerIdentityAssertion("s", "subj", nil, true, DefaultAssertionTTL, now), "sess", "req", now))

	// A dispatch with no trigger name is not one.
	require.Nil(t, VerifyDispatchAssertion("s", MintDispatchAssertion("s", Dispatch{ForcedAgentID: "a"}, "sess", "req", DefaultAssertionTTL, now), "sess", "req", now))
}
