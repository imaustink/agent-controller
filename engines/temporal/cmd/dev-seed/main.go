// dev-seed populates Qdrant with a small sample catalog for cluster-less
// development — the same records catalog-sync would derive from Tool/Skill
// CRs. Pair with TOOLRUN_MODE=fake on the worker to exercise the full agent
// loop locally.
package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/llm"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

func main() {
	ctx := context.Background()

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY is required (embeddings)")
	}
	embedder := llm.NewEmbedder(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_EMBED_MODEL", llm.DefaultEmbedModel),
	)

	qdrantHost := getenv("QDRANT_HOST", "127.0.0.1")
	qdrantPort, err := strconv.Atoi(getenv("QDRANT_PORT", "6334"))
	if err != nil {
		log.Fatalf("invalid QDRANT_PORT: %v", err)
	}
	client, collections, err := vectorstore.OpenCollections(ctx, qdrantHost, qdrantPort, embedder, llm.DefaultEmbedDims, os.Getenv("QDRANT_COLLECTION_PREFIX"))
	if err != nil {
		log.Fatalf("open qdrant collections: %v", err)
	}
	defer client.Close()

	indexer := catalog.NewIndexer(collections)

	tools := []catalog.ToolDescriptor{
		{
			ID:           "recipe-scraper",
			Description:  "Extracts a recipe from any URL (web page, video, or image) and returns clean recipe Markdown.",
			Input:        "a URL pointing at a recipe",
			Output:       "recipe as Markdown",
			AllowedRoles: []string{"cook", "admin"},
		},
		{
			ID:           "web-fetch",
			Description:  "Fetches a web page and returns its readable text content.",
			Input:        "a URL",
			Output:       "page text",
			AllowedRoles: []string{"cook", "admin", "researcher"},
		},
	}
	for _, tool := range tools {
		if err := indexer.UpsertTool(ctx, tool); err != nil {
			log.Fatalf("seed tool %s: %v", tool.ID, err)
		}
	}

	skills := []catalog.SkillDescriptor{
		{
			ID:          "recipe-collection",
			Description: "Fetch, extract, and present recipes from links the user shares.",
			Markdown: "# Recipe collection\n" +
				"When the user shares a link to a recipe, call recipe-scraper with the URL to extract it, " +
				"then present the recipe Markdown to the user unchanged. " +
				"Prefix the result with one short friendly sentence.",
			ToolIDs: []string{"recipe-scraper"},
		},
	}
	for _, skill := range skills {
		if err := indexer.UpsertSkill(ctx, skill); err != nil {
			log.Fatalf("seed skill %s: %v", skill.ID, err)
		}
	}

	agents := []catalog.AgentDescriptor{
		{
			ID:                 "swe-helper",
			Description:        "Makes code changes: fixes bugs, adds features, opens pull requests.",
			OrchestratorPrompt: "Delegate when the user wants code written or changed.",
			SkillRefs:          nil,
			AllowedRoles:       []string{"cook", "admin"}, // dev roles
			MaxIterations:      6,
			StepToolRef:        "swe-step", // checkpoint-resume pod agent
		},
		{
			ID:                 "meal-planner",
			Description:        "Plans meals across multiple days, gathering recipes and asking the user about preferences.",
			OrchestratorPrompt: "Delegate when the user wants multi-day meal planning rather than a single recipe.",
			AgentPrompt:        "You are a meal planner. Gather what you need (days, preferences), collect recipes, and produce a day-by-day plan.",
			SkillRefs:          []string{"recipe-collection"},
			AllowedRoles:       []string{"cook", "admin"},
			MaxIterations:      6,
		},
	}
	for _, agent := range agents {
		if err := indexer.UpsertAgent(ctx, agent); err != nil {
			log.Fatalf("seed agent %s: %v", agent.ID, err)
		}
	}

	log.Printf("seeded %d tools, %d skills, %d agents into qdrant at %s:%d", len(tools), len(skills), len(agents), qdrantHost, qdrantPort)
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
