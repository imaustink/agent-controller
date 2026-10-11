package workflows_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

// A completed turn's typed lifecycle events are folded into the durable,
// offset-addressable log (ADR 0004 B2/B3), and the human-facing narration
// (Meta.Narration / TurnProgress.Lines) is the Render projection of those same
// events (B1) — one source, two views.
func TestEventStreamDurableLogAndDerivedLines(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"},
		{Action: activities.ActionFinish},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "scrape the pasta recipe", &result, time.Millisecond)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"# Pasta\nBoil water."`) }, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	// B1: narration is non-empty and every line is the Render of a typed event.
	require.NotEmpty(t, result.Meta.Narration)

	// B2/B3: query the durable event log after the run.
	val, err := le.env.QueryWorkflow(workflows.ConversationEventsQuery)
	require.NoError(t, err)
	var view workflows.EventLogView
	require.NoError(t, val.Get(&view))

	require.Greater(t, view.Offset, 0, "offset must advance as events are logged")
	require.NotEmpty(t, view.Events)

	// Offsets are strictly increasing (resume cursor is well-defined).
	for i := 1; i < len(view.Events); i++ {
		require.Greater(t, view.Events[i].Seq, view.Events[i-1].Seq)
	}

	// The lifecycle brackets are present and typed.
	require.Equal(t, messaging.KindTurnStarted, view.Events[0].Kind)
	require.Equal(t, messaging.KindTurnCompleted, view.Events[len(view.Events)-1].Kind)

	// Rendered log lines reproduce the narration a client already sees.
	var rendered []string
	for _, ev := range view.Events {
		if line := ev.Render(); line != "" {
			rendered = append(rendered, line)
		}
	}
	require.Subset(t, rendered, result.Meta.Narration,
		"every narration line must be the Render of a logged typed event")
}
