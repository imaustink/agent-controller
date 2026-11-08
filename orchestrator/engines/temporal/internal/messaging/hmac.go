package messaging

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"
)

// SignatureHeader carries the body HMAC on callback requests.
const SignatureHeader = "x-signature"

// Sign produces the `sha256=<hex>` header value the CallbackSink writes:
// HMAC-SHA256 over the exact request body.
func Sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Verify checks a signature header against the raw body, timing-safely.
func Verify(secret string, body []byte, header string) error {
	if secret == "" {
		return fmt.Errorf("no callback secret configured")
	}
	if !strings.HasPrefix(header, "sha256=") {
		return fmt.Errorf("missing or malformed signature header")
	}
	expected := Sign(secret, body)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(header)) != 1 {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}
