// Package gateway is the stateless HTTP front door: an OpenAI
// Chat Completions-compatible facade that forwards each turn to a
// per-session conversation workflow via update-with-start.
//
// In later milestones it also hosts the HMAC callback receiver that
// translates tool-Job events into workflow signals.
package gateway

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"

	"durable-agents/internal/workflows"
)

// ModelID is the single model this facade advertises.
const ModelID = "durable-agents"

// sessionHeaders are checked in order for a stable conversation id.
// X-OpenWebUI-Chat-Id is sent by Open WebUI when its deployment sets
// ENABLE_FORWARD_USER_INFO_HEADERS=true.
var sessionHeaders = []string{"X-OpenWebUI-Chat-Id", "X-Session-Id"}

const maxSeedHistoryMessages = 8

type Server struct {
	temporal  client.Client
	taskQueue string
}

func NewServer(temporal client.Client, taskQueue string) *Server {
	return &Server{temporal: temporal, taskQueue: taskQueue}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("POST /v1/chat/completions", s.handleChatCompletions)
	return mux
}

// --- OpenAI wire types (only the fields we use) ---

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatCompletionRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type chatCompletionChoice struct {
	Index        int          `json:"index"`
	Message      *chatMessage `json:"message,omitempty"`
	Delta        *chatMessage `json:"delta,omitempty"`
	FinishReason *string      `json:"finish_reason"`
}

type chatCompletionResponse struct {
	ID      string                 `json:"id"`
	Object  string                 `json:"object"`
	Model   string                 `json:"model"`
	Choices []chatCompletionChoice `json:"choices"`
}

func (s *Server) handleModels(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data": []map[string]any{
			{"id": ModelID, "object": "model", "owned_by": ModelID},
		},
	})
}

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	var req chatCompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}

	userMessage, seedHistory, err := splitMessages(req.Messages)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sessionID, ephemeral := resolveSessionID(r)
	workflowID := "conversation-" + sessionID
	turnInput := workflows.TurnInput{Message: userMessage}
	if len(seedHistory) > 0 {
		turnInput.SeedHistory = seedHistory
	}

	startOp := s.temporal.NewWithStartWorkflowOperation(client.StartWorkflowOptions{
		ID:                       workflowID,
		TaskQueue:                s.taskQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
	}, workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))

	updateHandle, err := s.temporal.UpdateWithStartWorkflow(r.Context(), client.UpdateWithStartWorkflowOptions{
		StartWorkflowOperation: startOp,
		UpdateOptions: client.UpdateWorkflowOptions{
			WorkflowID:   workflowID,
			UpdateName:   workflows.UserTurnUpdate,
			WaitForStage: client.WorkflowUpdateStageCompleted,
			Args:         []any{turnInput},
		},
	})
	if err != nil {
		log.Printf("update-with-start failed: workflow=%s err=%v", workflowID, err)
		writeError(w, http.StatusBadGateway, "failed to reach conversation workflow: "+err.Error())
		return
	}

	var result workflows.TurnResult
	if err := updateHandle.Get(r.Context(), &result); err != nil {
		log.Printf("turn failed: workflow=%s err=%v", workflowID, err)
		writeError(w, http.StatusBadGateway, "turn failed: "+err.Error())
		return
	}

	completionID := "chatcmpl-" + uuid.NewString()
	if ephemeral {
		log.Printf("served ephemeral turn (no session header): workflow=%s", workflowID)
	}

	if req.Stream {
		writeStreamed(w, completionID, result.Reply)
		return
	}
	stop := "stop"
	writeJSON(w, http.StatusOK, chatCompletionResponse{
		ID:     completionID,
		Object: "chat.completion",
		Model:  ModelID,
		Choices: []chatCompletionChoice{
			{Message: &chatMessage{Role: "assistant", Content: result.Reply}, FinishReason: &stop},
		},
	})
}

// splitMessages returns the trailing user message as the turn, and every
// prior user/assistant message as seed history (bounded, system dropped).
func splitMessages(messages []chatMessage) (string, []workflows.ChatMessage, error) {
	last := len(messages) - 1
	if last < 0 || messages[last].Role != "user" || strings.TrimSpace(messages[last].Content) == "" {
		return "", nil, fmt.Errorf("last message must be a non-empty user message")
	}

	var history []workflows.ChatMessage
	for _, m := range messages[:last] {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		history = append(history, workflows.ChatMessage{Role: m.Role, Content: m.Content})
	}
	if len(history) > maxSeedHistoryMessages {
		history = history[len(history)-maxSeedHistoryMessages:]
	}
	return messages[last].Content, history, nil
}

// resolveSessionID returns a stable conversation id from headers, or a random
// ephemeral one (stateless turn, like today's "no chat id" path).
func resolveSessionID(r *http.Request) (id string, ephemeral bool) {
	for _, h := range sessionHeaders {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" {
			return sanitizeID(v), false
		}
	}
	return uuid.NewString(), true
}

// sanitizeID keeps session ids safe for use inside workflow ids.
func sanitizeID(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, s)
}

// writeStreamed emits the already-complete reply as a minimal SSE stream so
// stream:true clients work. Real incremental streaming (progress queries)
// lands in milestone 5.
func writeStreamed(w http.ResponseWriter, completionID, reply string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	writeChunk := func(choice chatCompletionChoice) {
		payload, _ := json.Marshal(chatCompletionResponse{
			ID:      completionID,
			Object:  "chat.completion.chunk",
			Model:   ModelID,
			Choices: []chatCompletionChoice{choice},
		})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		if flusher != nil {
			flusher.Flush()
		}
	}

	writeChunk(chatCompletionChoice{Delta: &chatMessage{Role: "assistant", Content: reply}})
	stop := "stop"
	writeChunk(chatCompletionChoice{Delta: &chatMessage{}, FinishReason: &stop})
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"message": message, "type": "durable_agents_error"},
	})
}
