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
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"

	"durable-agents/internal/rbac"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
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
	identity  rbac.Resolver
}

func NewServer(temporal client.Client, taskQueue string, identity rbac.Resolver) *Server {
	return &Server{temporal: temporal, taskQueue: taskQueue, identity: identity}
}

func (s *Server) Handler() http.Handler {
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	router.GET("/v1/models", s.handleModels)
	router.POST("/v1/chat/completions", s.handleChatCompletions)
	return router
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
	// Event carries Open WebUI status updates on stream chunks; other
	// clients ignore the unknown field.
	Event *statusEvent `json:"event,omitempty"`
}

type statusEvent struct {
	Type string     `json:"type"`
	Data statusData `json:"data"`
}

type statusData struct {
	Description string `json:"description"`
	Done        bool   `json:"done"`
}

func (s *Server) handleModels(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data": []gin.H{
			{"id": ModelID, "object": "model", "owned_by": ModelID},
		},
	})
}

func (s *Server) handleChatCompletions(c *gin.Context) {
	var req chatCompletionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}

	userMessage, seedHistory, err := splitMessages(req.Messages)
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}

	sessionID, ephemeral := resolveSessionID(c)
	workflowID := "conversation-" + sessionID
	turnInput := workflows.TurnInput{Message: userMessage, Caller: resolveCaller(c, s.identity)}
	if len(seedHistory) > 0 {
		turnInput.SeedHistory = seedHistory
	}

	if ephemeral {
		log.Printf("serving ephemeral turn (no session header): workflow=%s", workflowID)
	}

	waitFor := client.WorkflowUpdateStageCompleted
	if req.Stream {
		// Return as soon as the update is admitted, then stream progress
		// while it runs.
		waitFor = client.WorkflowUpdateStageAccepted
	}
	startOp := s.temporal.NewWithStartWorkflowOperation(client.StartWorkflowOptions{
		ID:                       workflowID,
		TaskQueue:                s.taskQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
	}, workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))

	updateHandle, err := s.temporal.UpdateWithStartWorkflow(c.Request.Context(), client.UpdateWithStartWorkflowOptions{
		StartWorkflowOperation: startOp,
		UpdateOptions: client.UpdateWorkflowOptions{
			WorkflowID:   workflowID,
			UpdateName:   workflows.UserTurnUpdate,
			WaitForStage: waitFor,
			Args:         []any{turnInput},
		},
	})
	if err != nil {
		log.Printf("update-with-start failed: workflow=%s err=%v", workflowID, err)
		writeError(c, http.StatusBadGateway, "failed to reach conversation workflow: "+err.Error())
		return
	}

	completionID := "chatcmpl-" + uuid.NewString()
	if req.Stream {
		s.streamTurn(c, workflowID, completionID, updateHandle)
		return
	}

	var result workflows.TurnResult
	if err := updateHandle.Get(c.Request.Context(), &result); err != nil {
		log.Printf("turn failed: workflow=%s err=%v", workflowID, err)
		writeError(c, http.StatusBadGateway, "turn failed: "+err.Error())
		return
	}
	stop := "stop"
	c.JSON(http.StatusOK, chatCompletionResponse{
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

// resolveCaller maps the bearer token to an identity. Unresolved callers get
// an empty subject — every capability downstream fails closed on that.
func resolveCaller(c *gin.Context, resolver rbac.Resolver) activities.Caller {
	if resolver == nil {
		return activities.Caller{}
	}
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	id := resolver.Resolve(strings.TrimSpace(token))
	if id == nil {
		return activities.Caller{}
	}
	return activities.Caller{Subject: id.Subject, Roles: id.Roles}
}

// resolveSessionID returns a stable conversation id from headers, or a random
// ephemeral one (stateless turn, like today's "no chat id" path).
func resolveSessionID(c *gin.Context) (id string, ephemeral bool) {
	for _, h := range sessionHeaders {
		if v := strings.TrimSpace(c.GetHeader(h)); v != "" {
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

const (
	progressPollInterval = 700 * time.Millisecond
	heartbeatInterval    = 15 * time.Second
)

// streamTurn streams a running turn: the workflow's narration as Open WebUI
// status events (unknown fields are ignored by other OpenAI clients), SSE
// keep-alive comments while quiet, then the reply as a content delta once
// the update completes. Mid-turn lines come from polling TurnProgressQuery;
// the final flush uses the authoritative narration in the turn result.
func (s *Server) streamTurn(c *gin.Context, workflowID, completionID string, updateHandle client.WorkflowUpdateHandle) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Status(http.StatusOK)

	writeChunk := func(chunk chatCompletionResponse) {
		chunk.ID = completionID
		chunk.Object = "chat.completion.chunk"
		chunk.Model = ModelID
		payload, _ := json.Marshal(chunk)
		fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
		c.Writer.Flush()
	}
	writeStatus := func(line string) {
		writeChunk(chatCompletionResponse{Event: &statusEvent{
			Type: "status",
			Data: statusData{Description: line},
		}})
	}

	writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{Delta: &chatMessage{Role: "assistant"}}}})

	type turnDone struct {
		result workflows.TurnResult
		err    error
	}
	done := make(chan turnDone, 1)
	go func() {
		var result workflows.TurnResult
		err := updateHandle.Get(c.Request.Context(), &result)
		done <- turnDone{result, err}
	}()

	poll := time.NewTicker(progressPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()

	seen := 0
	for {
		select {
		case d := <-done:
			if d.err != nil {
				log.Printf("streamed turn failed: workflow=%s err=%v", workflowID, d.err)
				// Headers are long flushed — failure has to ride the stream.
				writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{Delta: &chatMessage{Content: "❌ The turn failed: " + d.err.Error()}}}})
			} else {
				for _, line := range d.result.Meta.Narration[min(seen, len(d.result.Meta.Narration)):] {
					writeStatus(line)
				}
				writeStatus("done")
				writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{Delta: &chatMessage{Content: d.result.Reply}}}})
			}
			stop := "stop"
			writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{Delta: &chatMessage{}, FinishReason: &stop}}})
			fmt.Fprint(c.Writer, "data: [DONE]\n\n")
			c.Writer.Flush()
			return

		case <-poll.C:
			// Best-effort: only lines from the currently-active turn buffer;
			// the completion flush above catches anything missed.
			resp, err := s.temporal.QueryWorkflow(c.Request.Context(), workflowID, "", workflows.TurnProgressQuery)
			if err != nil {
				continue
			}
			var progress workflows.TurnProgress
			if resp.Get(&progress) != nil || !progress.Active {
				continue
			}
			for _, line := range progress.Lines[min(seen, len(progress.Lines)):] {
				writeStatus(line)
			}
			seen = max(seen, len(progress.Lines))

		case <-heartbeat.C:
			fmt.Fprint(c.Writer, ": keep-alive\n\n")
			c.Writer.Flush()

		case <-c.Request.Context().Done():
			return
		}
	}
}

func writeError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{
		"error": gin.H{"message": message, "type": "durable_agents_error"},
	})
}
