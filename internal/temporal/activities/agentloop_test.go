package activities_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/catalog"
	"durable-agents/internal/llm"
	"durable-agents/internal/temporal/activities"
)

// fakeLLM returns a canned JSON payload and records the last prompt.
type fakeLLM struct {
	payload    string
	lastSystem string
	lastUser   string
}

func (f *fakeLLM) Complete(context.Context, []llm.Message) (string, error) {
	return f.payload, nil
}

func (f *fakeLLM) CompleteJSON(_ context.Context, messages []llm.Message, _ llm.ResponseSchema) (json.RawMessage, error) {
	for _, m := range messages {
		switch m.Role {
		case "system":
			f.lastSystem = m.Content
		case "user":
			f.lastUser = m.Content
		}
	}
	return json.RawMessage(f.payload), nil
}

func TestSelectSkillValidatesCandidateID(t *testing.T) {
	fake := &fakeLLM{payload: `{"skill_id":"hallucinated"}`}
	a := &activities.AgentLoopActivities{LLM: fake}

	id, err := a.SelectSkill(context.Background(), activities.SelectSkillInput{
		Request:    "scrape this recipe",
		Candidates: []catalog.SkillDescriptor{{ID: "recipes", Description: "recipe workflows"}},
	})
	require.NoError(t, err)
	require.Empty(t, id, "hallucinated skill id must become no-match")
	require.Contains(t, fake.lastUser, "id: recipes", "candidates must be in the prompt")

	fake.payload = `{"skill_id":"recipes"}`
	id, err = a.SelectSkill(context.Background(), activities.SelectSkillInput{
		Request:    "scrape this recipe",
		Candidates: []catalog.SkillDescriptor{{ID: "recipes", Description: "recipe workflows"}},
	})
	require.NoError(t, err)
	require.Equal(t, "recipes", id)
}

func TestCheckNeedsCapabilityDefaultsTrueOnGarbage(t *testing.T) {
	a := &activities.AgentLoopActivities{LLM: &fakeLLM{payload: `not json`}}
	needs, err := a.CheckNeedsCapability(context.Background(), "hi")
	require.NoError(t, err)
	require.True(t, needs, "ambiguity must default to the capability path")
}

func TestCheckSkillFitDefaultsFalseOnGarbage(t *testing.T) {
	a := &activities.AgentLoopActivities{LLM: &fakeLLM{payload: `not json`}}
	fits, err := a.CheckSkillFit(context.Background(), activities.CheckSkillFitInput{Request: "x"})
	require.NoError(t, err)
	require.False(t, fits, "ambiguity must fall back to full retrieval")
}

func TestPlanActionRejectsUnknownAction(t *testing.T) {
	a := &activities.AgentLoopActivities{LLM: &fakeLLM{payload: `{"action":"explode","tool_id":"","tool_input":"","response":""}`}}
	_, err := a.PlanAction(context.Background(), activities.PlanActionInput{Request: "x"})
	require.Error(t, err)
}

func TestPlanActionFoldsHistoryAndSkillPrompt(t *testing.T) {
	fake := &fakeLLM{payload: `{"action":"finish","tool_id":"","tool_input":"","response":""}`}
	a := &activities.AgentLoopActivities{LLM: fake}

	plan, err := a.PlanAction(context.Background(), activities.PlanActionInput{
		Request:       "get the recipe",
		SkillMarkdown: "# Recipe workflow instructions",
		Tools:         []catalog.ToolDescriptor{{ID: "recipe-scraper", Description: "scrapes"}},
		History: []activities.ActionRecord{
			{ToolID: "recipe-scraper", Input: "url", Succeeded: true, Result: "# Pasta"},
		},
	})
	require.NoError(t, err)
	require.Equal(t, activities.ActionFinish, plan.Action)
	require.Contains(t, fake.lastSystem, "# Recipe workflow instructions", "skill markdown is the system prompt")
	require.Contains(t, fake.lastUser, "succeeded: # Pasta", "history must be in the prompt")
}
