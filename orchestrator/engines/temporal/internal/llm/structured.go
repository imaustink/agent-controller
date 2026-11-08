package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// ResponseSchema names a strict JSON schema for structured outputs.
type ResponseSchema struct {
	Name   string
	Schema json.RawMessage
}

type structuredRequest struct {
	Model          string         `json:"model"`
	Messages       []Message      `json:"messages"`
	ResponseFormat responseFormat `json:"response_format"`
}

type responseFormat struct {
	Type       string     `json:"type"` // "json_schema"
	JSONSchema jsonSchema `json:"json_schema"`
}

type jsonSchema struct {
	Name   string          `json:"name"`
	Strict bool            `json:"strict"`
	Schema json.RawMessage `json:"schema"`
}

// CompleteJSON runs one chat completion constrained to the given schema and
// returns the raw JSON content for the caller to decode.
func (c *Client) CompleteJSON(ctx context.Context, messages []Message, schema ResponseSchema) (json.RawMessage, error) {
	body, err := json.Marshal(structuredRequest{
		Model:    c.model,
		Messages: messages,
		ResponseFormat: responseFormat{
			Type:       "json_schema",
			JSONSchema: jsonSchema{Name: schema.Name, Strict: true, Schema: schema.Schema},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal structured request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build structured request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("structured request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read structured response: %w", err)
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("decode structured response (status %d): %w", resp.StatusCode, err)
	}
	if resp.StatusCode != http.StatusOK {
		msg := string(raw)
		if parsed.Error != nil {
			msg = parsed.Error.Message
		}
		return nil, fmt.Errorf("structured completion (%s) returned %d: %s", schema.Name, resp.StatusCode, msg)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("structured completion (%s) returned no choices", schema.Name)
	}
	return json.RawMessage(parsed.Choices[0].Message.Content), nil
}
