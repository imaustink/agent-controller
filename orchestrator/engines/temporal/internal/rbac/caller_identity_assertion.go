package rbac

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"time"
)

// CallerIdentityHeader carries agent-orchestrator's signed claim about which
// per-request identity it already resolved for a chat/invoke turn -- the
// caller's OWN OIDC/static/forwarded-user-JWT resolution, NOT this gateway's
// bearer-token map.
//
// Every internal hop from agent-orchestrator otherwise authenticates with ONE
// shared service token (or none, degrading to WithDefaultIdentity), so every
// caller resolves to the SAME subject regardless of which human is actually
// chatting -- collapsing every Open WebUI user onto one identity, the same
// bug class ADR 0030 fixed for webhooks via SenderAssertionHeader. This is
// that fix generalized: a resolved SUBJECT (and its roles) rather than a
// GitHub login, signed for the same reason -- an unsigned field would let
// anything holding the gateway's token name an arbitrary subject.
const CallerIdentityHeader = "x-gateway-caller-identity"

// callerIdentityPayload is the claim set. Field order matters for the same
// reason as assertionPayload's: it must match TypeScript's
// mintCallerIdentityAssertion field-insertion order for the signature to
// verify across implementations.
type callerIdentityPayload struct {
	Subject string   `json:"subject"`
	Roles   []string `json:"roles"`
	// PerUser mirrors activities.Caller.PerUser (see its doc comment): true
	// only when agent-orchestrator resolved Subject from a per-request signed
	// identity, never from a shared static/bearer token.
	PerUser bool  `json:"perUser"`
	Exp     int64 `json:"exp"` // unix seconds
}

// MintCallerIdentityAssertion produces `<payload>.<signature>` for a resolved
// subject/roles/perUser triple. Same HMAC scheme as MintSenderAssertion
// (reuses this package's signAssertion), deliberately kept as a separate
// payload/header rather than overloading assertionPayload: this asserts a
// resolved caller identity, not a GitHub login, and the two claims are
// verified independently by different call sites.
func MintCallerIdentityAssertion(secret, subject string, roles []string, perUser bool, ttl time.Duration, now time.Time) string {
	payload := callerIdentityPayload{Subject: subject, Roles: roles, PerUser: perUser, Exp: now.Unix() + int64(ttl.Seconds())}
	raw, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(raw)
	return payloadB64 + "." + signAssertion(secret, payloadB64)
}

// VerifyCallerIdentityAssertion returns the asserted subject/roles/perUser,
// or ("", nil, false) if the assertion is missing, malformed, expired, or not
// signed by secret. Fails closed and silently, same discipline as
// VerifySenderAssertion.
func VerifyCallerIdentityAssertion(secret, assertion string, now time.Time) (string, []string, bool) {
	if secret == "" || assertion == "" {
		return "", nil, false
	}

	dot := -1
	for i := 0; i < len(assertion); i++ {
		if assertion[i] == '.' {
			if dot >= 0 {
				return "", nil, false
			}
			dot = i
		}
	}
	if dot <= 0 || dot == len(assertion)-1 {
		return "", nil, false
	}
	payloadB64, signature := assertion[:dot], assertion[dot+1:]

	expected := signAssertion(secret, payloadB64)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return "", nil, false
	}

	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return "", nil, false
	}
	var payload callerIdentityPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", nil, false
	}
	if payload.Subject == "" || payload.Exp <= 0 {
		return "", nil, false
	}
	if payload.Exp*1000 <= now.UnixMilli() {
		return "", nil, false
	}
	return payload.Subject, payload.Roles, payload.PerUser
}
