// Package workflows holds deterministic Temporal workflow code only.
// All I/O (LLM calls, vector stores, k8s) lives in internal/activities.
package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/llm"
)

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
}

const (
	// idleTimeout ends the conversation workflow after a quiet period; a new
	// turn on the same session id simply starts a fresh workflow.
	idleTimeout = 30 * time.Minute

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
}

type TurnResult struct {
	Reply string   `json:"reply"`
	Turn  int      `json:"turn"`
	Meta  TurnMeta `json:"meta"`
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

		progress = TurnProgress{Turn: state.Turns + 1, Active: true}
		defer func() { progress.Active = false }()
		note := func(line string) { progress.Lines = append(progress.Lines, line) }

		reply, meta, err := runAgentTurn(ctx, actx, state, in, note)
		if err != nil {
			// Drop the failed turn's user message so a retry re-sends it cleanly.
			state.History = state.History[:len(state.History)-1]
			return TurnResult{}, err
		}
		meta.Narration = progress.Lines

		state.History = trimHistory(append(state.History, ChatMessage{Role: "assistant", Content: reply}), maxHistoryMessages)
		state.Turns++
		return TurnResult{Reply: reply, Turn: state.Turns, Meta: meta}, nil
	}); err != nil {
		return err
	}

	logger := workflow.GetLogger(ctx)
	for {
		turnsAtWait := state.Turns
		completedTurn, err := workflow.AwaitWithTimeout(ctx, idleTimeout, func() bool {
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
