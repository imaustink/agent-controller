// Package messaging is the Go port of agent-controller's
// @controller-agent/messaging wire contracts: the tool event stream
// (accepted → progress*/warning* → succeeded|failed) and its HMAC callback
// signing. Tool containers keep emitting exactly what they emit today; only
// the receiver changed.
package messaging

import (
	"encoding/json"
	"fmt"
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

// Event is the TS discriminated union flattened into one struct; Validate
// enforces the per-type requirements.
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

func (e Event) Validate() error {
	if e.JobID == "" {
		return fmt.Errorf("event missing job_id")
	}
	if e.Seq < 0 {
		return fmt.Errorf("event seq must be non-negative, got %d", e.Seq)
	}
	if e.TS == "" {
		return fmt.Errorf("event missing ts")
	}
	switch e.Type {
	case EventAccepted, EventProgress:
		return nil
	case EventWarning:
		if e.Message == "" {
			return fmt.Errorf("warning event missing message")
		}
	case EventSucceeded:
		if len(e.Result) == 0 {
			return fmt.Errorf("succeeded event missing result")
		}
	case EventFailed:
		if e.Code == "" || e.Message == "" {
			return fmt.Errorf("failed event missing code/message")
		}
	default:
		return fmt.Errorf("unknown event type %q", e.Type)
	}
	return nil
}

// ParseEvent decodes and validates one callback body.
func ParseEvent(raw []byte) (Event, error) {
	var e Event
	if err := json.Unmarshal(raw, &e); err != nil {
		return Event{}, fmt.Errorf("decode event: %w", err)
	}
	if err := e.Validate(); err != nil {
		return Event{}, err
	}
	return e, nil
}
