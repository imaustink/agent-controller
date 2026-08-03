package catalog_test

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"durable-agents/internal/catalog"
)

func toolCR(name string, spec map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.controller-agent.dev/v1alpha1",
		"kind":       "Tool",
		"metadata":   map[string]any{"name": name},
		"spec":       spec,
	}}
}

func TestDecodeTool(t *testing.T) {
	tool, err := catalog.DecodeTool(toolCR("recipe-scraper", map[string]any{
		"description":  "Scrapes recipes from URLs",
		"input":        "a recipe URL",
		"output":       "recipe markdown",
		"allowedRoles": []any{"cook", "admin"},
		"tier":         "standard",
		"image":        "ghcr.io/x/recipe-scraper:latest", // launch field, ignored
	}))
	require.NoError(t, err)
	require.Equal(t, "recipe-scraper", tool.ID)
	require.Equal(t, []string{"cook", "admin"}, tool.AllowedRoles)
	require.Empty(t, tool.AgentRef)
	require.Empty(t, tool.IdentityProviders)
	require.Contains(t, tool.EmbeddingText(), "Input: a recipe URL")
}

// A container Tool can require a linked identity of its own (upstream ADR
// 0032 §2) — previously this only ever came from a wrapped Agent CR.
func TestDecodeToolIdentityProviders(t *testing.T) {
	tool, err := catalog.DecodeTool(toolCR("github", map[string]any{
		"description":       "Runs a gh CLI command as the calling user",
		"allowedRoles":      []any{"developer"},
		"identityProviders": []any{"github"},
	}))
	require.NoError(t, err)
	require.Equal(t, []string{"github"}, tool.IdentityProviders)
}

// Agent.spec.toolRefs scopes what the sub-agent's OWN loop may call (upstream
// ADR 0028), which is a different question from skillRefs' prompt material.
func TestDecodeAgentToolRefs(t *testing.T) {
	agent, err := catalog.DecodeAgent(&unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.controller-agent.dev/v1alpha1",
		"kind":       "Agent",
		"metadata":   map[string]any{"name": "cluster-debug"},
		"spec": map[string]any{
			"description":  "Debugs cluster problems",
			"allowedRoles": []any{"sre"},
			"skillRefs":    []any{"skill-cluster-debug"},
			"toolRefs":     []any{"kubectl-readonly", "signoz-query"},
		},
	}})
	require.NoError(t, err)
	require.Equal(t, []string{"kubectl-readonly", "signoz-query"}, agent.ToolRefs)
	require.Equal(t, []string{"skill-cluster-debug"}, agent.SkillRefs)
}

func TestDecodeSkill(t *testing.T) {
	skill, err := catalog.DecodeSkill(&unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.controller-agent.dev/v1alpha1",
		"kind":       "Skill",
		"metadata":   map[string]any{"name": "recipe-refining"},
		"spec": map[string]any{
			"description": "Refine and publish recipes",
			"markdown":    "# Recipe workflow\n...",
			"toolRefs":    []any{"recipe-scraper", "recipe-publisher"},
		},
	}})
	require.NoError(t, err)
	require.Equal(t, []string{"recipe-scraper", "recipe-publisher"}, skill.ToolIDs)
	require.False(t, skill.Unrestricted)
	require.Nil(t, skill.EffectiveRoles)
}

// AllowCallerTools is a *bool because nil means ALLOWED (upstream ADR 0035
// §4). Decoding an unset field to a non-nil false would silently refuse
// caller tools on every Skill CR that predates the feature — which is why
// this is pinned rather than left to the zero value.
func TestDecodeSkillAllowCallerTools(t *testing.T) {
	skillCR := func(spec map[string]any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "core.controller-agent.dev/v1alpha1",
			"kind":       "Skill",
			"metadata":   map[string]any{"name": "s"},
			"spec":       spec,
		}}
	}

	t.Run("unset stays nil", func(t *testing.T) {
		skill, err := catalog.DecodeSkill(skillCR(map[string]any{"description": "d", "markdown": "m"}))
		require.NoError(t, err)
		require.Nil(t, skill.AllowCallerTools)
	})

	t.Run("explicit false is distinguishable from unset", func(t *testing.T) {
		skill, err := catalog.DecodeSkill(skillCR(map[string]any{"description": "d", "markdown": "m", "allowCallerTools": false}))
		require.NoError(t, err)
		require.NotNil(t, skill.AllowCallerTools)
		require.False(t, *skill.AllowCallerTools)
	})
}

func routeCR(name string, spec map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.controller-agent.dev/v1alpha1",
		"kind":       "IntegrationRoute",
		"metadata":   map[string]any{"name": name},
		"spec":       spec,
	}}
}

func TestDecodeIntegrationRoute(t *testing.T) {
	route, err := catalog.DecodeIntegrationRoute(routeCR("github-issue-labeled-triage", map[string]any{
		"match": map[string]any{
			"source": "github", "event": "issues", "action": "labeled", "labelName": "ai-triage",
		},
		"agentRef":       "claude-code-swe-agent",
		"promptTemplate": "Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}",
	}))
	require.NoError(t, err)
	require.Equal(t, "github-issue-labeled-triage", route.ID)
	require.Equal(t, "claude-code-swe-agent", route.AgentRef)
	require.Equal(t, "ai-triage", route.Match.LabelName)
	require.Contains(t, route.PromptTemplate, "{{issueNumber}}")
}

func TestIntegrationRouteSpecificity(t *testing.T) {
	// Most specific wins: action+labelName > action > labelName > neither.
	// A single source/event/action triple can carry more than one intent, so
	// the ordering is what keeps two applicable routes from being a coin flip.
	both := catalog.IntegrationRouteDescriptor{Match: catalog.IntegrationRouteMatch{Action: "labeled", LabelName: "ai-triage"}}
	action := catalog.IntegrationRouteDescriptor{Match: catalog.IntegrationRouteMatch{Action: "labeled"}}
	label := catalog.IntegrationRouteDescriptor{Match: catalog.IntegrationRouteMatch{LabelName: "ai-triage"}}
	neither := catalog.IntegrationRouteDescriptor{}

	require.Greater(t, both.Specificity(), action.Specificity())
	require.Greater(t, action.Specificity(), label.Specificity())
	require.Greater(t, label.Specificity(), neither.Specificity())
}

func TestDecodeIntegrationRouteRejectsAmbiguousTarget(t *testing.T) {
	// CEL enforces this upstream, but a route with two targets would silently
	// pick one here — cheaper to fail at decode than to debug a route that
	// dispatches to the wrong place.
	_, err := catalog.DecodeIntegrationRoute(routeCR("two-targets", map[string]any{
		"match":          map[string]any{"source": "github", "event": "issues"},
		"skillRef":       "skill-triage",
		"agentRef":       "agent-triage",
		"promptTemplate": "x",
	}))
	require.ErrorContains(t, err, "exactly one of")

	_, err = catalog.DecodeIntegrationRoute(routeCR("no-target", map[string]any{
		"match":          map[string]any{"source": "github", "event": "issues"},
		"promptTemplate": "x",
	}))
	require.ErrorContains(t, err, "exactly one of")

	_, err = catalog.DecodeIntegrationRoute(routeCR("no-match", map[string]any{
		"match":          map[string]any{"source": "github"},
		"skillRef":       "skill-triage",
		"promptTemplate": "x",
	}))
	require.ErrorContains(t, err, "match.source and match.event")
}

func TestDecodeMissingSpec(t *testing.T) {
	_, err := catalog.DecodeTool(&unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "broken"},
	}})
	require.Error(t, err)
}

func TestDeriveSkillAccess(t *testing.T) {
	tools := map[string]catalog.ToolDescriptor{
		"scraper":   {ID: "scraper", AllowedRoles: []string{"cook", "admin"}},
		"publisher": {ID: "publisher", AllowedRoles: []string{"admin", "cook", "editor"}},
		"nobody":    {ID: "nobody", AllowedRoles: []string{}},
	}
	agents := map[string]catalog.AgentDescriptor{
		"swe": {ID: "swe", AllowedRoles: []string{"admin"}},
	}

	t.Run("no refs is unrestricted", func(t *testing.T) {
		s := catalog.DeriveSkillAccess(catalog.SkillDescriptor{ID: "chat"}, tools, agents)
		require.True(t, s.Unrestricted)
		require.Nil(t, s.EffectiveRoles)
	})

	t.Run("intersection of tool roles", func(t *testing.T) {
		s := catalog.DeriveSkillAccess(catalog.SkillDescriptor{
			ID: "recipes", ToolIDs: []string{"scraper", "publisher"},
		}, tools, agents)
		require.False(t, s.Unrestricted)
		require.ElementsMatch(t, []string{"cook", "admin"}, s.EffectiveRoles)
	})

	t.Run("agent ref narrows the intersection", func(t *testing.T) {
		s := catalog.DeriveSkillAccess(catalog.SkillDescriptor{
			ID: "coding", ToolIDs: []string{"scraper"}, AgentIDs: []string{"swe"},
		}, tools, agents)
		require.Equal(t, []string{"admin"}, s.EffectiveRoles)
	})

	t.Run("dangling ref fails closed", func(t *testing.T) {
		s := catalog.DeriveSkillAccess(catalog.SkillDescriptor{
			ID: "broken", ToolIDs: []string{"scraper", "missing"},
		}, tools, agents)
		require.False(t, s.Unrestricted)
		require.Empty(t, s.EffectiveRoles)
		require.NotNil(t, s.EffectiveRoles)
	})

	t.Run("disjoint roles fail closed", func(t *testing.T) {
		s := catalog.DeriveSkillAccess(catalog.SkillDescriptor{
			ID: "impossible", ToolIDs: []string{"scraper", "nobody"},
		}, tools, agents)
		require.Empty(t, s.EffectiveRoles)
	})
}
