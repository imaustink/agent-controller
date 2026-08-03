package workflows

import (
	"github.com/google/uuid"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/callertools"
	"durable-agents/internal/temporal/activities"
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
func pendingCallerCall(
	ctx workflow.Context,
	offered []callertools.Descriptor,
	plan activities.PlannedAction,
) (callertools.PendingCall, bool) {
	name := callertools.NameFromID(plan.ToolID)
	found := false
	for _, tool := range offered {
		if tool.Name == name {
			found = true
			break
		}
	}
	if !found {
		return callertools.PendingCall{}, false
	}

	// SideEffect: a uuid is non-deterministic, and this id has to stay stable
	// across replay or a resumed turn would fail to match its own call.
	var id string
	if err := workflow.SideEffect(ctx, func(workflow.Context) any {
		return "call_" + uuid.NewString()
	}).Get(&id); err != nil {
		return callertools.PendingCall{}, false
	}

	// Arguments go out verbatim as the planner produced them. OpenAI's wire
	// format is a JSON-encoded string, and the prompt tells the planner to emit
	// an object literal for a caller tool; an empty input becomes "{}" rather
	// than "", which no client can parse.
	arguments := plan.ToolInput
	if arguments == "" {
		arguments = "{}"
	}
	return callertools.PendingCall{ID: id, Name: name, Arguments: arguments}, true
}
