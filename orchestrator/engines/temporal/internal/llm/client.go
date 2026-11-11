// Package llm is a minimal OpenAI-compatible chat-completions client.
//
// It is deliberately dependency-free: milestone 1 only needs plain
// completions, and a hand-rolled client keeps the base URL overridable
// (LiteLLM, Ollama, etc.). Swap for the official SDK if/when structured
// outputs get complex enough to warrant it.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Client struct {
	baseURL string
	apiKey  string
	model   string
	http    *http.Client
}

func New(baseURL, apiKey, model string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    &http.Client{Timeout: 120 * time.Second},
	}
}

func (c *Client) Model() string { return c.model }

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
	// Usage is token accounting, recorded on the call's generation span
	// (docs/adr/0050). Absent from some OpenAI-compatible servers.
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage,omitempty"`
}

// Complete sends one chat-completions request and returns the assistant text.
func (c *Client) Complete(ctx context.Context, messages []Message) (_ string, err error) {
	ctx, span := c.startGeneration(ctx, "chat", "")
	defer func() { endGeneration(span, err) }()

	body, err := json.Marshal(chatRequest{Model: c.model, Messages: messages})
	if err != nil {
		return "", fmt.Errorf("marshal chat request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build chat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("chat request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read chat response: %w", err)
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("decode chat response (status %d): %w", resp.StatusCode, err)
	}
	recordUsage(span, parsed)
	if resp.StatusCode != http.StatusOK {
		msg := string(raw)
		if parsed.Error != nil {
			msg = parsed.Error.Message
		}
		return "", fmt.Errorf("chat completions returned %d: %s", resp.StatusCode, msg)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("chat completions returned no choices")
	}
	return parsed.Choices[0].Message.Content, nil
}
