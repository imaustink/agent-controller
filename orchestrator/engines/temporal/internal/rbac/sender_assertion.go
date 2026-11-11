package rbac

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"time"
)

// SenderAssertionHeader carries integration-gateway's signed claim about WHO
// triggered a webhook turn (upstream ADR 0030 §6).
//
// The gateway authenticates to /invoke with its own service token, so that
// token says "the gateway is calling" and nothing about the human behind it.
// The sender login therefore travels separately — and signed, because it
// selects the caller's principal and hence which stored credentials the run
// receives. An unsigned field would let anything holding the gateway's token
// name an arbitrary login and be handed that person's credentials.
const SenderAssertionHeader = "x-gateway-user-assertion"

// DefaultAssertionTTL is how long a minted assertion stays valid. Seconds,
// not hours: it is created and consumed within one HTTP call.
const DefaultAssertionTTL = 300 * time.Second

// assertionPayload is the claim set. Field ORDER is load-bearing: Go emits
// struct fields in declaration order and the signature covers the encoded
// JSON, so swapping these two would silently stop verifying assertions minted
// by the TypeScript gateway. Pinned by the cross-implementation vectors in
// sender_assertion_test.go.
// Sender subject statuses (docs/adr/0049 §5): whether a verified sender
// resolved to the subject their linked accounts live under.
const (
	SenderSubjectLinked      = "linked"
	SenderSubjectUnlinked    = "unlinked"
	SenderSubjectAmbiguous   = "ambiguous"
	SenderSubjectUnavailable = "unavailable"
)

// SenderClaims is everything integration-gateway vouches for about a webhook
// sender. Login is all a pre-0049 assertion carries; the rest is additive.
type SenderClaims struct {
	Login string `json:"login"`
	// AccountID is the provider's immutable account id.
	AccountID string `json:"accountId,omitempty"`
	// Subject is the one subject the account is linked under; set only with
	// SubjectStatus "linked".
	Subject       string `json:"subject,omitempty"`
	SubjectStatus string `json:"subjectStatus,omitempty"`
}

type assertionPayload struct {
	SenderClaims
	Exp int64 `json:"exp"` // unix seconds
}

func signAssertion(secret, payloadB64 string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payloadB64))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// MintSenderAssertion produces `<payload>.<signature>` for a login.
//
// Deliberately not a JWT, matching upstream: the only claims needed are a
// login and an expiry, and both ends of this hop are ours. Wire-compatible
// with agent-orchestrator's mintSenderAssertion — an assertion minted by
// either implementation verifies with the other.
func MintSenderAssertion(secret, login string, ttl time.Duration, now time.Time) string {
	return MintSenderClaims(secret, SenderClaims{Login: login}, ttl, now)
}

// MintSenderClaims mints an assertion carrying the full claim set. A subject
// is only ever carried with SubjectStatus "linked".
func MintSenderClaims(secret string, claims SenderClaims, ttl time.Duration, now time.Time) string {
	if claims.SubjectStatus != SenderSubjectLinked {
		claims.Subject = ""
	}
	payload := assertionPayload{SenderClaims: claims, Exp: now.Unix() + int64(ttl.Seconds())}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "" // unreachable: two strings and an int
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(raw)
	return payloadB64 + "." + signAssertion(secret, payloadB64)
}

// VerifySenderAssertion returns the asserted login, or "" if the assertion is
// missing, malformed, expired, or not signed by secret.
//
// Fails closed and silently, like every other resolver here: a caller that
// cannot prove who they are is treated as not having said, which downstream
// means "no principal" rather than "someone else's principal".
func VerifySenderAssertion(secret, assertion string, now time.Time) string {
	if c := VerifySenderClaims(secret, assertion, now); c != nil {
		return c.Login
	}
	return ""
}

// VerifySenderClaims verifies an assertion and returns its claims, or nil. A
// subject that is not "linked" is dropped, so a caller can never act on one
// the gateway did not vouch for as THE linked subject.
func VerifySenderClaims(secret, assertion string, now time.Time) *SenderClaims {
	if secret == "" || assertion == "" {
		return nil
	}

	// Exactly two parts. Neither half can contain a '.' — both are base64url,
	// whose alphabet is [A-Za-z0-9_-] — so anything else was never minted by
	// either implementation.
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

	expected := signAssertion(secret, payloadB64)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return nil
	}

	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil
	}
	var payload assertionPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	if payload.Login == "" || payload.Exp <= 0 {
		return nil
	}
	if payload.Exp*1000 <= now.UnixMilli() {
		return nil
	}
	claims := payload.SenderClaims
	if claims.SubjectStatus != SenderSubjectLinked {
		claims.Subject = ""
	}
	return &claims
}

// WarnIfSenderAssertionUnset mirrors upstream's startup discipline: with no
// shared secret, an unsigned sender login riding the request body is still
// trusted, so the weaker mode must never be silent. Upgrading a deployment
// does not silently break it, but nobody gets to be surprised either.
func WarnIfSenderAssertionUnset(secret string) {
	if secret == "" {
		log.Printf("WARNING: GATEWAY_SENDER_ASSERTION_SECRET is not set — " +
			"/invoke will trust an unsigned event.senderLogin from anything holding its token. " +
			"Set the shared secret on both this gateway and integration-gateway to require a signed assertion.")
	}
}
