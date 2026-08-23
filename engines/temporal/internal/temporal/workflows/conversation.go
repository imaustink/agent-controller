// Package workflows holds deterministic Temporal workflow code only.
// All I/O (LLM calls, vector stores, k8s) lives in internal/activities.
package workflows

import (
	"strings"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/llm"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// remoteControlUrlNarrationPrefix is the exact narration line shape
// bridged_agent_workflow.go produces for a `Stage: "remote-control-url"`
// up-message (`msg.Stage + ": " + msg.Message`, agentrun.UpProgress case).
// Recognizing it here lets the conversation workflow lift the URL out of the
// plain narration transcript into a first-class field, instead of it being
// visible only as buried text a caller happens to grep for.
const remoteControlUrlNarrationPrefix = "remote-control-url: "

const (
	ConversationWorkflowName = "ConversationWorkflow"

	// UserTurnUpdate is the workflow update the gateway sends per chat turn
	// (via update-with-start), returning a TurnResult.
	UserTurnUpdate = "user-turn"

	// StateQuery exposes a small summary of the conversation for debugging.
	StateQuery = "conversation-state"

	// TurnProgressQuery exposes the in-flight turn's narration; the gateway
	// polls it to stream status while the update runs.
	TurnProgressQuery = "turn-progress"
)

// TurnProgress is the streamed view of one turn.
type TurnProgress struct {
	Turn   int      `json:"turn"`
	Active bool     `json:"active"`
	Lines  []string `json:"lines,omitempty"`
	// RemoteControlUrl is lifted out of Lines the moment a
	// remoteControlUrlNarrationPrefix line appears, so a polling caller can
	// link a live Remote Control session without parsing narration text.
	RemoteControlUrl string `json:"remoteControlUrl,omitempty"`
}

const (
	// idleTimeout ends the conversation workflow after a quiet period; a new
	// turn on the same session id simply starts a fresh workflow.
	idleTimeout = 30 * time.Minute

	// agentIdleTimeout applies instead while a child agent is mid-episode
	// waiting on the human — completing the conversation would terminate it
	// (parent close policy), so wait much longer.
	agentIdleTimeout = 24 * time.Hour

	// maxTurnsPerRun bounds event-history growth before continue-as-new.
	maxTurnsPerRun = 40

	// maxHistoryMessages bounds the durable transcript carried in state.
	maxHistoryMessages = 24

	systemPrompt = "You are durable-agents, a helpful assistant. Answer concisely."
)

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type TurnInput struct {
	Message string `json:"message"`

	// Caller is the identity the gateway resolved for this turn; retrieval
	// and tool access are scoped to it (fail closed on empty subject).
	Caller activities.Caller `json:"caller"`

	// SeedHistory carries the client-supplied transcript, adopted only when
	// this workflow has no durable history yet (e.g. the previous
	// conversation workflow idled out and completed).
	SeedHistory []ChatMessage `json:"seedHistory,omitempty"`

	// ForcedSkillID / ForcedAgentID name a target chosen deterministically
	// from an inbound event descriptor rather than inferred by retrieval
	// (upstream ADR 0024). The gateway sets one of these when the event
	// matched an IntegrationRoute CR; Message already carries that route's
	// rendered promptTemplate.
	//
	// These are a ROUTING hint, never an authorization one: the workflow
	// re-resolves the named target under the caller's current roles and
	// falls through to ordinary retrieval on a miss. An unmatched or
	// role-invisible target is not an error.
	ForcedSkillID string `json:"forcedSkillId,omitempty"`
	ForcedAgentID string `json:"forcedAgentId,omitempty"`

	// SenderLogin is the human an adapter vouched for, taken from a verified
	// sender assertion (upstream ADR 0030 §6) — the gateway authenticates as
	// itself, so the caller's own subject says nothing about who triggered
	// the turn. It selects the principal that credentials are keyed by, which
	// is why the gateway will only accept it signed once a secret is
	// configured. Consumed by the authorization pre-flight in A4; carried
	// through the loop unread until then.
	SenderLogin string `json:"senderLogin,omitempty"`

	// CallerTools are tools the consumer supplied in this request and will run
	// in their own client (ADR 0035), already parsed, validated and ranked by
	// the gateway. Untrusted text — see internal/callertools.
	CallerTools []callertools.Descriptor `json:"callerTools,omitempty"`
	// CallerToolRequired carries tool_choice: "required" as a directive.
	CallerToolRequired bool `json:"callerToolRequired,omitempty"`
	// PriorCallerToolCalls are calls the client already executed for this
	// exchange, read off the wire (there is no server-side conversation store
	// to read them from). They seed the planner's history, which also bounds a
	// resumed loop for free: the step cap counts history length, so a client
	// cannot drive an unbounded planner loop by resending.
	PriorCallerToolCalls []callertools.PriorCall `json:"priorCallerToolCalls,omitempty"`

	// Live says the caller is watching this turn as it runs (a streaming chat
	// request), as opposed to a fire-and-forget caller that will only ever see
	// the final result.
	//
	// It decides whether the authorization pre-flight may wait for a human to
	// finish linking an account. For a fire-and-forget caller it must not: the
	// link reaches that user only in the turn's result, so waiting would hide
	// the prompt for the whole window and could only ever time out. This is
	// the direct analogue of upstream keying the same decision off whether a
	// progressListener is attached.
	Live bool `json:"live,omitempty"`
}

type TurnResult struct {
	Reply string   `json:"reply"`
	Turn  int      `json:"turn"`
	Meta  TurnMeta `json:"meta"`

	// PendingToolCalls is the turn's SECOND non-error terminal shape (ADR
	// 0035): the planner chose a tool the CALLER supplied and must execute
	// themselves, so the turn ends by asking for it. Reply is empty here.
	//
	// Both consumer-facing protocols have to render it — the chat facade in
	// streaming and blocking modes, and /invoke's polled record.
	PendingToolCalls []callertools.PendingCall `json:"pendingToolCalls,omitempty"`
}

// ConversationState is the workflow's durable state, passed through
// continue-as-new. Pending identity links (the rest of today's
// SessionRecord) arrive with sub-agent delegation.
type ConversationState struct {
	History []ChatMessage `json:"history"`
	Turns   int           `json:"turns"`

	// ActiveSkillID is the conversation's current skill (ADR 0012): only the
	// id — content is re-fetched RBAC-checked every turn.
	ActiveSkillID string `json:"activeSkillId,omitempty"`

	// ToolContinuations holds each tool's opaque resume token (ADR 0017),
	// keyed by tool id. Tokens live only here — never in History, so the
	// LLM/transcript never sees them.
	ToolContinuations map[string]string `json:"toolContinuations,omitempty"`

	// Active agent episode (mid-HITL): the child AgentWorkflow waiting for
	// this conversation's next message.
	ActiveAgentID         string `json:"activeAgentId,omitempty"`
	ActiveAgentWorkflowID string `json:"activeAgentWorkflowId,omitempty"`

	// RemoteControlUrl is the active episode's Remote Control session URL
	// (see TurnProgress.RemoteControlUrl), carried forward across turns of
	// the SAME episode since a follow-up prompt's turn never re-emits it.
	// Cleared whenever ActiveAgentWorkflowID is (handleAgentUp's clearActive).
	RemoteControlUrl string `json:"remoteControlUrl,omitempty"`

	// AgentContinuations holds per-agent opaque episode tokens, prepended to
	// the same agent's next goal (never shown to the transcript).
	AgentContinuations map[string]string `json:"agentContinuations,omitempty"`

	// PendingIdentityLink anchors a turn that stopped to ask the caller to
	// link an account. It carries the ORIGINAL request, so the turn that
	// notices the link completed re-delegates the goal the user actually
	// asked for rather than whatever text happened to arrive next ("ok,
	// linked it").
	PendingIdentityLink *authz.PendingLink `json:"pendingIdentityLink,omitempty"`
}

type StateSummary struct {
	Turns          int `json:"turns"`
	HistoryLength  int `json:"historyLength"`
	TurnsThisRun   int `json:"turnsThisRun"`
	MaxTurnsPerRun int `json:"maxTurnsPerRun"`
}

// ConversationWorkflow is one long-lived workflow per chat session. Each user
// turn arrives as a "user-turn" update; the workflow completes after an idle
// timeout and continues-as-new when a single run has served enough turns.
func ConversationWorkflow(ctx workflow.Context, state *ConversationState) error {
	if state == nil {
		state = &ConversationState{}
	}
	startTurns := state.Turns

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})

	if err := workflow.SetQueryHandler(ctx, StateQuery, func() (StateSummary, error) {
		return StateSummary{
			Turns:          state.Turns,
			HistoryLength:  len(state.History),
			TurnsThisRun:   state.Turns - startTurns,
			MaxTurnsPerRun: maxTurnsPerRun,
		}, nil
	}); err != nil {
		return err
	}

	// Per-run progress buffer (not durable state: streaming is best-effort
	// and a continued-as-new run simply starts a fresh buffer).
	var progress TurnProgress
	if err := workflow.SetQueryHandler(ctx, TurnProgressQuery, func() (TurnProgress, error) {
		return progress, nil
	}); err != nil {
		return err
	}

	if err := workflow.SetUpdateHandler(ctx, UserTurnUpdate, func(ctx workflow.Context, in TurnInput) (TurnResult, error) {
		if len(state.History) == 0 && len(in.SeedHistory) > 0 {
			state.History = append(state.History, in.SeedHistory...)
		}
		state.History = append(state.History, ChatMessage{Role: "user", Content: in.Message})

		// Whether an episode was ALREADY running before this turn -- decides
		// whether a stale state.RemoteControlUrl belongs to the conversation
		// this turn is continuing (carry it forward) or to some earlier,
		// now-unrelated episode (drop it). Read before runAgentTurn mutates
		// ActiveAgentWorkflowID.
		episodeWasActive := state.ActiveAgentWorkflowID != ""

		progress = TurnProgress{Turn: state.Turns + 1, Active: true}
		defer func() { progress.Active = false }()
		note := func(line string) {
			progress.Lines = append(progress.Lines, line)
			if url, ok := strings.CutPrefix(line, remoteControlUrlNarrationPrefix); ok {
				progress.RemoteControlUrl = url
			}
		}

		reply, meta, pending, err := runAgentTurn(ctx, actx, state, in, note)
		if err != nil {
			// Drop the failed turn's user message so a retry re-sends it cleanly.
			state.History = state.History[:len(state.History)-1]
			return TurnResult{}, err
		}
		meta.Narration = progress.Lines
		switch {
		case progress.RemoteControlUrl != "":
			// This turn's own episode start/continuation reported it.
			meta.RemoteControlUrl = progress.RemoteControlUrl
			state.RemoteControlUrl = progress.RemoteControlUrl
		case episodeWasActive && state.RemoteControlUrl != "":
			// A follow-up prompt to an episode that reported its URL on an
			// earlier turn — that turn's narration is gone, so carry it
			// forward rather than losing it, including on the very turn the
			// episode concludes (handleAgentUp has already cleared
			// ActiveAgentWorkflowID by the time we get here).
			meta.RemoteControlUrl = state.RemoteControlUrl
			if state.ActiveAgentWorkflowID == "" {
				state.RemoteControlUrl = "" // episode ended this turn
			}
		default:
			state.RemoteControlUrl = ""
		}

		// A turn ending in caller tool calls is a real terminal state, but not a
		// completed exchange: the client runs the function and resends. The
		// user's message stays in history (they said it) and no assistant reply
		// is folded in, because there is no answer yet — the resend arrives as
		// the next turn carrying its own results.
		if len(pending) > 0 {
			state.Turns++
			return TurnResult{Turn: state.Turns, Meta: meta, PendingToolCalls: pending}, nil
		}

		// The self-improvement footer is a hint for the human, not content.
		// Left in the transcript it re-enters every later turn's prompt, and
		// its "no existing skill or agent matched" wording biases the next
		// turn's selection toward repeating "no match" even for a request
		// that plainly fits a real skill.
		state.History = trimHistory(append(state.History,
			ChatMessage{Role: "assistant", Content: stripSelfImprovementFooter(reply)}), maxHistoryMessages)
		state.Turns++
		return TurnResult{Reply: reply, Turn: state.Turns, Meta: meta}, nil
	}); err != nil {
		return err
	}

	logger := workflow.GetLogger(ctx)
	for {
		timeout := idleTimeout
		if state.ActiveAgentWorkflowID != "" {
			timeout = agentIdleTimeout
		}
		turnsAtWait := state.Turns
		completedTurn, err := workflow.AwaitWithTimeout(ctx, timeout, func() bool {
			return state.Turns > turnsAtWait
		})
		if err != nil {
			return err
		}

		if !completedTurn {
			// Idle — but an update may still be mid-LLM-call; only complete
			// once every handler has drained.
			if workflow.AllHandlersFinished(ctx) {
				logger.Info("conversation idle, completing", "turns", state.Turns)
				return nil
			}
			continue
		}

		if state.Turns-startTurns >= maxTurnsPerRun {
			if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
				return err
			}
			logger.Info("continuing as new", "turns", state.Turns)
			return workflow.NewContinueAsNewError(ctx, ConversationWorkflowName, state)
		}
	}
}

func toLLMMessages(history []ChatMessage) []llm.Message {
	out := make([]llm.Message, len(history))
	for i, m := range history {
		out[i] = llm.Message{Role: m.Role, Content: m.Content}
	}
	return out
}

func trimHistory(history []ChatMessage, max int) []ChatMessage {
	if len(history) <= max {
		return history
	}
	return history[len(history)-max:]
}
