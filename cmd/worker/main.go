package main

import (
	"log"
	"os"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/activities"
	"durable-agents/internal/llm"
	"durable-agents/internal/workflows"
)

func main() {
	temporalAddress := getenv("TEMPORAL_ADDRESS", "127.0.0.1:7233")
	temporalNamespace := getenv("TEMPORAL_NAMESPACE", "default")
	taskQueue := getenv("TASK_QUEUE", "durable-agents")

	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY is required")
	}
	llmClient := llm.New(
		getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		apiKey,
		getenv("OPENAI_MODEL", "gpt-4o-2024-08-06"),
	)

	c, err := client.Dial(client.Options{
		HostPort:  temporalAddress,
		Namespace: temporalNamespace,
	})
	if err != nil {
		log.Fatalf("dial temporal at %s: %v", temporalAddress, err)
	}
	defer c.Close()

	w := worker.New(c, taskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(workflows.ConversationWorkflow, workflow.RegisterOptions{
		Name: workflows.ConversationWorkflowName,
	})
	w.RegisterActivityWithOptions((&activities.LLMActivities{Client: llmClient}).CompleteTurn, activity.RegisterOptions{
		Name: activities.CompleteTurnActivityName,
	})

	log.Printf("worker starting: temporal=%s namespace=%s taskQueue=%s model=%s",
		temporalAddress, temporalNamespace, taskQueue, llmClient.Model())
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
