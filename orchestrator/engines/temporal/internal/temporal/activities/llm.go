// Package activities holds all non-deterministic work invoked from
// workflows. Workflow code may import the types and name constants here,
// but never the implementations.
package activities

import (
	"context"

	"github.com/controller-agent/temporal-engine/internal/llm"
)

const CompleteTurnActivityName = "CompleteTurn"

type CompleteTurnInput struct {
	SystemPrompt string        `json:"systemPrompt"`
	Messages     []llm.Message `json:"messages"`
}

type LLMActivities struct {
	Client *llm.Client
}

// CompleteTurn runs one plain chat completion over the conversation so far.
func (a *LLMActivities) CompleteTurn(ctx context.Context, in CompleteTurnInput) (string, error) {
	messages := make([]llm.Message, 0, len(in.Messages)+1)
	if in.SystemPrompt != "" {
		messages = append(messages, llm.Message{Role: "system", Content: in.SystemPrompt})
	}
	messages = append(messages, in.Messages...)
	return a.Client.Complete(ctx, messages)
}
