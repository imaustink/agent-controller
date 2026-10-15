package rbac

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"time"
)

// DispatchAssertionHeader carries agent-orchestrator's signed, resolved
// EventTrigger dispatch for one /invoke turn (ADR 0048,
// docs/event-triggers.md §5).
//
// agent-orchestrator matches events against its own EventTrigger registry and
// forwards the RESULT -- the forced target, its input, params, the trigger's
// readOnly and name. Each of those is a dispatch decision: a forced agent
// skips the trigger's match rules, and a trigger-produced turn decides the
// conversation's read-only mode. The /invoke bearer token alone says only
// "someone allowed to call /invoke", so these travel signed and bound to the
// turn's session and prompt, never as body fields anything holding that
// token could write.
const DispatchAssertionHeader = "x-orchestrator-dispatch-assertion"

// dispatchAssertionType separates this claim from the sender and caller
// identity assertions, which are signed with the same secret.
const dispatchAssertionType = "dispatch"

// Dispatch is the resolved trigger turn a DispatchAssertion vouches for.
type Dispatch struct {
	TriggerName   string            `json:"triggerName"`
	ForcedSkillID string            `json:"forcedSkillId,omitempty"`
	ForcedAgentID string            `json:"forcedAgentId,omitempty"`
	ForcedToolID  string            `json:"forcedToolId,omitempty"`
	ToolInput     string            `json:"toolInput,omitempty"`
	ReadOnly      bool              `json:"readOnly,omitempty"`
	Params        map[string]string `json:"params,omitempty"`
}

// dispatchPayload is the claim set. Unlike the identity assertions it is
// never re-encoded to verify (the signature covers the received bytes and the
// payload is only decoded), so field order is not load-bearing here.
type dispatchPayload struct {
	Typ string `json:"typ"`
	Dispatch
	// SessionID and RequestSHA256 bind the dispatch to one turn: a captured
	// header cannot be replayed onto another conversation or another prompt.
	SessionID     string `json:"sessionId"`
	RequestSHA256 string `json:"requestSha256"`
	Exp           int64  `json:"exp"` // unix seconds
}

// RequestDigest is the hex SHA-256 of a turn's request text, as bound into a
// dispatch assertion.
func RequestDigest(request string) string {
	sum := sha256.Sum256([]byte(request))
	return hex.EncodeToString(sum[:])
}

// MintDispatchAssertion produces `<payload>.<signature>` for a resolved
// dispatch. Wire-compatible with agent-orchestrator's mintDispatchAssertion.
func MintDispatchAssertion(secret string, d Dispatch, sessionID, request string, ttl time.Duration, now time.Time) string {
	payload := dispatchPayload{
		Typ:           dispatchAssertionType,
		Dispatch:      d,
		SessionID:     sessionID,
		RequestSHA256: RequestDigest(request),
		Exp:           now.Unix() + int64(ttl.Seconds()),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(raw)
	return payloadB64 + "." + signAssertion(secret, payloadB64)
}

// VerifyDispatchAssertion returns the dispatch an assertion vouches for, or
// nil if it is missing, malformed, expired, not signed by secret, not a
// dispatch claim, or bound to a different session or request. Fails closed.
func VerifyDispatchAssertion(secret, assertion, sessionID, request string, now time.Time) *Dispatch {
	if secret == "" || assertion == "" {
		return nil
	}
	dot := -1
	for i := 0; i < len(assertion); i++ {
		if assertion[i] == '.' {
			if dot >= 0 {
				return nil
			}
			dot = i
		}
	}
	if dot <= 0 || dot == len(assertion)-1 {
		return nil
	}
	payloadB64, signature := assertion[:dot], assertion[dot+1:]
	if !hmac.Equal([]byte(signAssertion(secret, payloadB64)), []byte(signature)) {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil
	}
	var payload dispatchPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	if payload.Typ != dispatchAssertionType || payload.TriggerName == "" || payload.Exp <= 0 {
		return nil
	}
	if payload.Exp*1000 <= now.UnixMilli() {
		return nil
	}
	if payload.SessionID != sessionID || !hmac.Equal([]byte(payload.RequestSHA256), []byte(RequestDigest(request))) {
		return nil
	}
	d := payload.Dispatch
	return &d
}
