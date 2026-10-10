// Package messaging holds the engine's side of the wire: the tool event stream
// (accepted → progress*/warning* → succeeded|failed), its HMAC callback
// signing, and the turn lifecycle envelope. Validity is decided by the
// canonical contract in framework/protocol (see CheckContract); the structs
// here are this engine's internal representation of messages that passed it.
package messaging

import (
	"encoding/json"
	"fmt"

	protocolv1 "github.com/imaustink/agent-controller/framework/protocol/go/agentcontroller/protocol/v1"
)

const (
	EventAccepted  = "accepted"
	EventProgress  = "progress"
	EventWarning   = "warning"
	EventSucceeded = "succeeded"
	EventFailed    = "failed"
)

// ArtifactRef points at out-of-band bytes; payloads never travel inline.
type ArtifactRef struct {
	URI         string `json:"uri"`
	SHA256      string `json:"sha256"`
	Bytes       int64  `json:"bytes"`
	ContentType string `json:"content_type"`
}

// Event is the wire's flat, type-tagged event as one struct. Which fields each
// type requires is the contract's business (ParseEvent), not this struct's.
type Event struct {
	JobID string `json:"job_id"`
	Seq   int    `json:"seq"`
	TS    string `json:"ts"`
	Type  string `json:"type"`

	// accepted
	URL string `json:"url,omitempty"`

	// progress
	Stage string   `json:"stage,omitempty"`
	Pct   *float64 `json:"pct,omitempty"`

	// progress / warning / failed
	Message string `json:"message,omitempty"`

	// succeeded
	Result    json.RawMessage `json:"result,omitempty"`
	Artifacts []ArtifactRef   `json:"artifacts,omitempty"`

	// failed
	Code string `json:"code,omitempty"`
}

// Terminal reports whether this event ends the job's stream.
func (e Event) Terminal() bool {
	return e.Type == EventSucceeded || e.Type == EventFailed
}

// ResultText renders a succeeded result for LLM/user consumption: JSON
// strings unwrap to their value, everything else stays raw JSON.
func (e Event) ResultText() string {
	var s string
	if err := json.Unmarshal(e.Result, &s); err == nil {
		return s
	}
	return string(e.Result)
}

// ParseEvent validates one callback body against the wire contract, then
// decodes it into an Event. The result keeps the tool's raw `result` bytes
// exactly as sent.
func ParseEvent(raw []byte) (Event, error) {
	if err := CheckContract(raw, &protocolv1.Event{}); err != nil {
		return Event{}, fmt.Errorf("event violates the wire contract: %w", err)
	}
	var e Event
	if err := json.Unmarshal(raw, &e); err != nil {
		return Event{}, fmt.Errorf("decode event: %w", err)
	}
	return e, nil
}
