package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// Each scenario must pass its ideal move and FAIL the failure it exists to
// catch — otherwise a model's score would mean nothing.
func TestEveryScenarioSeparatesTheRightMoveFromTheFailureItTargets(t *testing.T) {
	call := func(tool, input string) activities.PlannedAction {
		return activities.PlannedAction{Action: activities.ActionCallTool, ToolID: tool, ToolInput: input}
	}
	respond := func(text string) activities.PlannedAction {
		return activities.PlannedAction{Action: activities.ActionRespond, Response: text}
	}

	cases := map[string]struct{ good, bad activities.PlannedAction }{
		"1 retro": {call(searchTool, "SNC retro action items"), respond("Here are the action items.")},
		"2 retro": {call(readTool, "snc-confluence/2114289728"), respond("Set up a Kanban board [1].")},
		"3 retro": {
			respond("End of project: set up a Kanban board [4]. July retro: connect Paul with Jason [5]."),
			respond("Set up an internal Kanban board [1]."), // fragments only: misses the July retro
		},
		"4 latest": {
			call(queryTool, `{"source":"#team-snc","sort":"newest","limit":1}`),
			call(queryTool, "team-snc latest message"), // keywords cannot order by time
		},
		"5 latest": {call(queryTool, `{"source":"team-snc","sort":"newest"}`), respond("The latest was the Jira Initiative message [1].")},
		"6 latest": {
			respond("The most recent message is a channel join: @U0C3DFPAEP8 has joined the channel [1]."),
			respond("The latest was the evening update [2]."),
		},
	}

	_, tools := sncKnowledgeBase()
	scs := scenarios(tools)
	require.Len(t, scs, len(cases))
	for _, sc := range scs {
		prefix := sc.name[:strings.Index(sc.name, ":")]
		c, ok := cases[prefix]
		require.True(t, ok, sc.name)
		require.True(t, sc.pass(c.good), "%s should pass the right move", sc.name)
		require.False(t, sc.pass(c.bad), "%s should fail the failure it targets", sc.name)
	}
}

// The eval must hand the model the tools production generates, including the
// live faces these scenarios depend on.
func TestTheEvalOffersTheGeneratedLiveFaces(t *testing.T) {
	skill, tools := sncKnowledgeBase()
	ids := map[string]bool{}
	for _, tool := range tools {
		ids[tool.ID] = true
	}
	for _, id := range []string{searchTool, readTool, queryTool} {
		require.True(t, ids[id], id)
	}
	require.Contains(t, skill.Markdown, "query with `\"sort\": \"newest\"`")
}
