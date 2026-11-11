package rbac

import (
	"encoding/base64"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// docs/adr/0049 §5: the gateway's extended claims round-trip, a subject is only
// ever honoured as "linked", and an older login-only verifier still reads the
// login out of an extended assertion.
func TestSenderClaimsRoundTripAndOnlyALinkedSubjectSurvives(t *testing.T) {
	now := time.Now()
	linked := MintSenderClaims("s", SenderClaims{Login: "alice", AccountID: "583231", Subject: "openwebui:a", SubjectStatus: SenderSubjectLinked}, DefaultAssertionTTL, now)
	got := VerifySenderClaims("s", linked, now)
	require.NotNil(t, got)
	require.Equal(t, SenderClaims{Login: "alice", AccountID: "583231", Subject: "openwebui:a", SubjectStatus: SenderSubjectLinked}, *got)
	require.Equal(t, "alice", VerifySenderAssertion("s", linked, now), "login-only verification is unchanged")

	// A subject riding alongside a non-linked status is never honoured, even
	// if something minted one.
	payload := `{"login":"alice","accountId":"1","subject":"openwebui:x","subjectStatus":"ambiguous","exp":` +
		strconv.FormatInt(now.Unix()+60, 10) + `}`
	b64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	forged := VerifySenderClaims("s", b64+"."+signAssertion("s", b64), now)
	require.NotNil(t, forged)
	require.Empty(t, forged.Subject)
	require.Equal(t, SenderSubjectAmbiguous, forged.SubjectStatus)

	require.Nil(t, VerifySenderClaims("other", linked, now), "wrong secret")
}

// A vector minted by integration-gateway's own TypeScript mintSenderAssertion
// (exp 2100-01-01) -- not reimplemented here -- so the claim set the gateway
// signs is the one this verifier reads (docs/adr/0049 §5).
func TestSenderClaimsVerifyAGatewayMintedVector(t *testing.T) {
	const vector = "eyJsb2dpbiI6ImFsaWNlIiwiYWNjb3VudElkIjoiNTgzMjMxIiwic3ViamVjdFN0YXR1cyI6ImxpbmtlZCIsInN1YmplY3QiOiJvcGVud2VidWk6YSIsImV4cCI6NDEwMjQ0NDgwMH0.zZp81J2ee26VtYhc9IndlPieNkCe0M7MqHMc_1LkH_4"
	got := VerifySenderClaims("cross-language-secret", vector, time.Now())
	require.NotNil(t, got)
	require.Equal(t, SenderClaims{Login: "alice", AccountID: "583231", Subject: "openwebui:a", SubjectStatus: SenderSubjectLinked}, *got)
}
