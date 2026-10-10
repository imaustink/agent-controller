package workflows

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// seedHistory turns calls the client already executed into planner history
// (upstream ADR 0035 §1).
//
// Two things fall out of seeding rather than re-deriving. The planner sees its
// own prior results, so it stops re-issuing the same call forever — before this
// existed upstream, prior tool results were dropped entirely. And the per-turn
// step cap counts history length, so a resumed loop is bounded for free: a
// client cannot drive an unbounded planner loop by resending a longer
// conversation.
func seedHistory(prior []callertools.PriorCall) []activities.ActionRecord {
	if len(prior) == 0 {
		return nil
	}
	history := make([]activities.ActionRecord, 0, len(prior))
	for _, call := range prior {
		history = append(history, activities.ActionRecord{
			ToolID: callertools.ID(call.Name),
			Input:  call.Arguments,
			// A result that came back at all is a result: the client executed
			// the function and reported what happened. Whether its content
			// describes a failure is the planner's to read.
			Succeeded: true,
			Result:    call.Result,
		})
	}
	return history
}

// lastHistoryResult is the most recent successful result in history, or "".
func lastHistoryResult(history []activities.ActionRecord) string {
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Succeeded && history[i].Result != "" {
			return history[i].Result
		}
	}
	return ""
}

// pendingCallerCall validates the planner's chosen caller tool against the set
// actually offered this turn, and mints the correlation id the client echoes
// back.
//
// The re-validation matters as much here as for a catalog tool: the planner may
// not invent a name. Because caller ids are namespaced, a planner cannot reach
// a Tool CR through this branch either.
//
// A non-nil error means the tool WAS found but its arguments are malformed
// (upstream's callerToolArguments, graph.ts:805-820) — that fails the whole
// turn rather than forwarding a call the caller's own client can't parse.
func pendingCallerCall(
	ctx workflow.Context,
	offered []callertools.Descriptor,
	plan activities.PlannedAction,
) (callertools.PendingCall, bool, error) {
	name := callertools.NameFromID(plan.ToolID)
	found := false
	for _, tool := range offered {
		if tool.Name == name {
			found = true
			break
		}
	}
	if !found {
		return callertools.PendingCall{}, false, nil
	}

	arguments, err := callerToolArguments(plan.ToolInput)
	if err != nil {
		return callertools.PendingCall{}, false, fmt.Errorf("tool %s needs JSON arguments: %w", plan.ToolID, err)
	}

	// SideEffect: a uuid is non-deterministic, and this id has to stay stable
	// across replay or a resumed turn would fail to match its own call.
	var id string
	if err := workflow.SideEffect(ctx, func(workflow.Context) any {
		return "call_" + uuid.NewString()
	}).Get(&id); err != nil {
		return callertools.PendingCall{}, false, nil
	}

	return callertools.PendingCall{ID: id, Name: name, Arguments: arguments}, true, nil
}

// callerToolArguments validates the planner's tool_args as the JSON-object
// arguments a caller tool needs (upstream ADR 0035, graph.ts's
// callerToolArguments). Every other dispatch kind takes a plain string
// argument; this is the one place the planner's output has a structural
// contract beyond "a string".
//
// A malformed value is an error rather than a coerced "{}": sending the
// caller's own client a call whose arguments silently don't match its schema
// produces a confusing client-side failure, whereas this surfaces the actual
// cause. Empty is fine and means "no arguments".
func callerToolArguments(toolInput string) (string, error) {
	raw := strings.TrimSpace(toolInput)
	if raw == "" {
		return "{}", nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return "", fmt.Errorf("expected a JSON object, got %q", truncate(raw, 120))
	}
	if _, ok := parsed.(map[string]any); !ok {
		return "", fmt.Errorf("expected a JSON object, got a non-object JSON value")
	}
	// Re-serialize so what reaches the client is canonical JSON regardless of
	// the planner's whitespace.
	canonical, err := json.Marshal(parsed)
	if err != nil {
		return "", err
	}
	return string(canonical), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
