package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/llm"
	"durable-agents/internal/temporal"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
	"durable-agents/internal/vectorstore"
)

func main() {
	cfg := temporal.ConfigFromEnv()

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY is required")
	}
	llmClient := llm.New(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_MODEL", "gpt-4o-2024-08-06"),
	)

	c, err := temporal.NewClient(cfg)
	if err != nil {
		log.Fatalf("dial temporal at %s: %v", cfg.Address, err)
	}
	defer c.Close()

	w := worker.New(c, cfg.TaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(workflows.ConversationWorkflow, workflow.RegisterOptions{
		Name: workflows.ConversationWorkflowName,
	})
	w.RegisterActivityWithOptions((&activities.LLMActivities{Client: llmClient}).CompleteTurn, activity.RegisterOptions{
		Name: activities.CompleteTurnActivityName,
	})

	// Retrieval activities need Qdrant; without it the worker still serves
	// plain conversations (hello-world mode).
	if qdrantHost := os.Getenv("QDRANT_HOST"); qdrantHost != "" {
		qdrantPort, err := strconv.Atoi(getenv("QDRANT_PORT", "6334"))
		if err != nil {
			log.Fatalf("invalid QDRANT_PORT: %v", err)
		}
		embedder := llm.NewEmbedder(
			getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
			apiKey,
			getenv("OPENAI_EMBED_MODEL", llm.DefaultEmbedModel),
		)
		qdrantClient, collections, err := vectorstore.OpenCollections(context.Background(), qdrantHost, qdrantPort, embedder, llm.DefaultEmbedDims)
		if err != nil {
			log.Fatalf("open qdrant collections: %v", err)
		}
		defer qdrantClient.Close()

		retrieval := &activities.RetrievalActivities{Collections: collections}
		w.RegisterActivityWithOptions(retrieval.RetrieveSkills, activity.RegisterOptions{Name: activities.RetrieveSkillsActivityName})
		w.RegisterActivityWithOptions(retrieval.RetrieveAgents, activity.RegisterOptions{Name: activities.RetrieveAgentsActivityName})
		w.RegisterActivityWithOptions(retrieval.ResolveSkillTools, activity.RegisterOptions{Name: activities.ResolveSkillToolsActivityName})
		log.Printf("retrieval activities enabled: qdrant=%s:%d", qdrantHost, qdrantPort)
	} else {
		log.Printf("QDRANT_HOST not set; retrieval activities disabled")
	}

	log.Printf("worker starting: temporal=%s namespace=%s taskQueue=%s model=%s",
		cfg.Address, cfg.Namespace, cfg.TaskQueue, llmClient.Model())
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("worker exited: %v", err)
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
