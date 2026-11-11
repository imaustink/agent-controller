// Package audit writes the launch audit trail (docs/adr/0049 §3): who launched
// an agent run, as which identity, with whose credentials.
//
// Two record kinds, one JSON object per line on stdout:
//
//   - "agent-authorization": every pre-flight decision, including refusals and
//     link prompts, written by the Authorize activity before anything starts.
//   - "agent-launch": every AgentRun actually created, written by the launch
//     activity, joined to its decision by decisionId.
//
// This line is the durable record. AgentRun CRs are garbage-collected, and
// the copy on AgentRun.spec.launch exists only for as long as the run does.
// It is deliberately NOT part of any tracing pipeline (docs/adr/0050): a trace
// may be sampled or dropped, and an audit record may not.
//
// Identifiers only. Nothing here ever holds credential material, which is
// why a record carries provider NAMES and whose credential each one uses,
// never a token or a Secret's contents.
package audit

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"
	"time"
)

const (
	KindAuthorization = "agent-authorization"
	KindLaunch        = "agent-launch"
)

// Entry points a launching turn can arrive through.
const (
	EntryChat    = "chat"    // a per-user caller (Open WebUI's forwarded identity)
	EntryWebhook = "webhook" // an EventTrigger turn whose sender an adapter vouched for
	EntryEvent   = "event"   // an EventTrigger turn with no sender (cron, an unsigned source)
	EntryAPI     = "api"     // any other direct /invoke caller
)

// EntryPoint classifies a turn from facts the engine already holds.
func EntryPoint(perUser bool, triggerName, senderLogin string) string {
	switch {
	case triggerName != "" && senderLogin != "":
		return EntryWebhook
	case triggerName != "":
		return EntryEvent
	case perUser:
		return EntryChat
	default:
		return EntryAPI
	}
}

// Sender identifies the human an adapter vouched for.
type Sender struct {
	Provider  string `json:"provider,omitempty"`
	Login     string `json:"login,omitempty"`
	AccountID string `json:"accountId,omitempty"`
}

// Credential says whose credential a provider's reads and writes use.
type Credential struct {
	Provider string `json:"provider"`
	Read     string `json:"read,omitempty"`
	Write    string `json:"write,omitempty"`
}

// Launch is what is known about a launch at decision time. It is carried from
// the pre-flight to the launcher, so the AgentRun's spec.launch and the
// agent-launch record say exactly what the decision said.
type Launch struct {
	DecisionID            string       `json:"decisionId,omitempty"`
	EntryPoint            string       `json:"entryPoint,omitempty"`
	LaunchedBy            string       `json:"launchedBy,omitempty"`
	DelegatedSubject      string       `json:"delegatedSubject,omitempty"`
	Sender                *Sender      `json:"sender,omitempty"`
	Trigger               string       `json:"trigger,omitempty"`
	RequestedIdentityMode string       `json:"requestedIdentityMode,omitempty"`
	IdentityMode          string       `json:"identityMode,omitempty"`
	IdentityModeSource    string       `json:"identityModeSource,omitempty"`
	Credentials           []Credential `json:"credentials,omitempty"`
	TargetRepository      string       `json:"targetRepository,omitempty"`
	ReadOnly              bool         `json:"readOnly,omitempty"`
}

// Record is one audit line.
type Record struct {
	Kind     string `json:"kind"`
	Time     string `json:"time"`
	Agent    string `json:"agent"`
	AgentRun string `json:"agentRun,omitempty"`
	// Outcome is the pre-flight verdict for an authorization record
	// (authorized | link-required | refused | misconfigured), and "launched"
	// for a launch record.
	Outcome string `json:"outcome"`
	// Conversation is the workflow the decision ran in; the session id is
	// derivable from it.
	Conversation string `json:"conversation,omitempty"`
	Launch
}

// Writer is where records go. stdout by default, swappable in tests.
type Writer struct {
	mu  sync.Mutex
	out io.Writer
	now func() time.Time
}

var std = &Writer{out: os.Stdout, now: time.Now}

// SetOutput redirects the package writer and returns a restore func. Tests
// only.
func SetOutput(w io.Writer, now func() time.Time) func() {
	std.mu.Lock()
	defer std.mu.Unlock()
	prevOut, prevNow := std.out, std.now
	std.out, std.now = w, now
	return func() {
		std.mu.Lock()
		defer std.mu.Unlock()
		std.out, std.now = prevOut, prevNow
	}
}

// Emit writes one record. A write failure is logged, never returned: the
// audit line must not be what fails a launch, and stdout failing means the
// process's logging is gone anyway.
func Emit(rec Record) {
	std.mu.Lock()
	defer std.mu.Unlock()
	if rec.Time == "" {
		rec.Time = std.now().UTC().Format(time.RFC3339Nano)
	}
	line, err := json.Marshal(rec)
	if err != nil {
		log.Printf("[audit] could not encode %s record for %s: %v", rec.Kind, rec.Agent, err)
		return
	}
	if _, err := std.out.Write(append(line, '\n')); err != nil {
		log.Printf("[audit] could not write %s record for %s: %v", rec.Kind, rec.Agent, err)
	}
}
