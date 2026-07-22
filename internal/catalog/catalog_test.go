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
	require.Contains(t, tool.EmbeddingText(), "Input: a recipe URL")
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
