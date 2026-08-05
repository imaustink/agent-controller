// Package gateway is the stateless HTTP front door: an OpenAI
// Chat Completions-compatible facade that forwards each turn to a
// per-session conversation workflow via update-with-start.
//
// In later milestones it also hosts the HMAC callback receiver that
// translates tool-Job events into workflow signals.
package gateway

import (
	"context"
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

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/rbac"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
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

	// routes is the live IntegrationRoute table (ADR 0024). Nil disables
	// deterministic dispatch entirely: /invoke still works, and every turn
	// goes through ordinary retrieval, exactly as before the feature existed.
	routes *catalog.RouteRegistry

	// senderAssertionSecret is shared with integration-gateway. Empty means
	// /invoke falls back to trusting an unsigned event.senderLogin — see
	// rbac.WarnIfSenderAssertionUnset.
	senderAssertionSecret string

	// callerTools ranks a consumer's own tool array (ADR 0035). Nil degrades to
	// truncation rather than dropping the feature: the caller still gets tool
	// calling, just without relevance ranking.
	callerTools    callertools.Store
	callerToolTopK int

	// taskCompleter answers a chat UI's housekeeping requests. Nil returns
	// empty text, which is what those requests get today.
	taskCompleter TaskCompleter
}

// TaskCompleter answers a chat UI's internal housekeeping completions (title,
// tags, search query) without touching the agent loop.
type TaskCompleter interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

// defaultCallerToolTopK matches upstream: only this many caller tools ever
// reach the planner prompt, the same discipline ADR 0008 applies to the
// catalog and for the same reason.
const defaultCallerToolTopK = 5

// Option configures a Server. Both of these are genuinely optional: a
// deployment that only serves chat needs neither a route table nor a shared
// secret with an adapter it does not run.
type Option func(*Server)

func WithRoutes(routes *catalog.RouteRegistry) Option {
	return func(s *Server) { s.routes = routes }
}

func WithSenderAssertionSecret(secret string) Option {
	return func(s *Server) { s.senderAssertionSecret = secret }
}

func WithCallerTools(store callertools.Store, topK int) Option {
	return func(s *Server) {
		s.callerTools = store
		if topK > 0 {
			s.callerToolTopK = topK
		}
	}
}

func WithTaskCompleter(completer TaskCompleter) Option {
	return func(s *Server) { s.taskCompleter = completer }
}

func NewServer(temporal client.Client, taskQueue string, identity rbac.Resolver, opts ...Option) *Server {
	s := &Server{
		temporal: temporal, taskQueue: taskQueue, identity: identity,
		callerToolTopK: defaultCallerToolTopK,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func (s *Server) Handler() http.Handler {
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	router.GET("/v1/models", s.handleModels)
	router.POST("/v1/chat/completions", s.handleChatCompletions)
	router.POST("/invoke", s.handleInvoke)
	router.GET("/invoke/:id", s.handleInvokeStatus)
	return router
}

// --- OpenAI wire types (only the fields we use) ---

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// ToolCalls is set only when a turn ends by asking the client to run its
	// own functions. Content is then null, per OpenAI's format.
	ToolCalls []toolCallPayload `json:"tool_calls,omitempty"`
}

type chatCompletionRequest struct {
	Model    string                    `json:"model"`
	Messages []callertools.WireMessage `json:"messages"`
	Stream   bool                      `json:"stream"`
	// Tools / ToolChoice are the consumer's own functions (ADR 0035). Every
	// standard OpenAI client sends these; ignoring them silently is the
	// behaviour that ADR exists to fix.
	Tools      []callertools.RawTool `json:"tools"`
	ToolChoice json.RawMessage       `json:"tool_choice"`
}

type toolCallPayload struct {
	Index    int    `json:"index,omitempty"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
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

	userMessage, seedHistory, lastUserIndex, err := splitMessages(req.Messages)
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}

	// Open WebUI's own housekeeping completions — chat title, tags, search
	// query, follow-up suggestions — arrive at this same endpoint. They are
	// short-circuited BEFORE any workflow is started or touched.
	//
	// That ordering is load-bearing now that caller tools exist: a
	// title-generation request that happens to carry the client's tool array
	// must return prose, never a tool call the client would then execute as a
	// side effect of rendering a chat title. It also keeps a housekeeping call
	// from ever reaching skill/agent delegation, where its embedded history
	// could match a privileged agent.
	if callertools.IsInternalUITask(userMessage) {
		s.completeInternalTask(c, req, userMessage)
		return
	}

	callerTools, choice, err := callertools.Parse(callertools.Request{Tools: req.Tools, ToolChoice: req.ToolChoice})
	if err != nil {
		// An OpenAI-shaped 400 rather than a silent drop: a client that offers
		// tools and gets prose back cannot tell whether the agent chose not to
		// call them or never saw them.
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}

	sessionID, ephemeral := resolveSessionID(c)
	workflowID := "conversation-" + sessionID
	// Live: a streaming request is watched as it runs, so the authorization
	// pre-flight may surface a link prompt and wait. A blocking request gets
	// its answer in one shot, same as a fire-and-forget caller.
	turnInput := workflows.TurnInput{
		Message:            userMessage,
		Caller:             resolveCaller(c, s.identity),
		Live:               req.Stream,
		CallerTools:        s.resolveCallerTools(c, userMessage, callerTools, choice),
		CallerToolRequired: choice.Required,
		// Read off the wire, not from a session: there is no server-side
		// conversation store to have put a caller's tool result in.
		PriorCallerToolCalls: callertools.CollectPriorCalls(req.Messages, lastUserIndex),
	}
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

	if len(result.PendingToolCalls) > 0 {
		reason := "tool_calls"
		c.JSON(http.StatusOK, chatCompletionResponse{
			ID:     completionID,
			Object: "chat.completion",
			Model:  ModelID,
			Choices: []chatCompletionChoice{{
				Message:      &chatMessage{Role: "assistant", ToolCalls: toolCallsPayload(result.PendingToolCalls)},
				FinishReason: &reason,
			}},
		})
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

// toolCallsPayload renders pending calls in OpenAI's wire shape. Index is
// required on each entry: it is how a streaming client assembles more than one.
func toolCallsPayload(calls []callertools.PendingCall) []toolCallPayload {
	out := make([]toolCallPayload, len(calls))
	for i, call := range calls {
		out[i].Index = i
		out[i].ID = call.ID
		out[i].Type = "function"
		out[i].Function.Name = call.Name
		out[i].Function.Arguments = call.Arguments
	}
	return out
}

// resolveCallerTools ranks the caller's tools down to what the planner will see.
//
// Runs in the GATEWAY, not the workflow: it embeds and queries Qdrant, which is
// I/O, and the result is a small, already-decided list. Passing the decision in
// also keeps the untrusted definitions out of any workflow that never uses them.
func (s *Server) resolveCallerTools(
	c *gin.Context,
	request string,
	tools []callertools.Descriptor,
	choice callertools.Choice,
) []callertools.Descriptor {
	if len(tools) == 0 {
		return nil
	}
	return callertools.Resolve(c.Request.Context(), request, tools, choice, s.callerToolTopK, s.callerTools)
}

// completeInternalTask answers a chat UI's housekeeping request directly.
//
// Deliberately a plain completion with no tools, no catalog, and no
// conversation workflow: this is not a user turn, and everything the agent loop
// does would be both wasted and dangerous here.
func (s *Server) completeInternalTask(c *gin.Context, req chatCompletionRequest, userMessage string) {
	completionID := "chatcmpl-" + uuid.NewString()
	stop := "stop"

	reply := ""
	if s.taskCompleter != nil {
		var err error
		if reply, err = s.taskCompleter.Complete(c.Request.Context(), userMessage); err != nil {
			log.Printf("internal UI task completion failed: %v", err)
			reply = ""
		}
	}

	if req.Stream {
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Status(http.StatusOK)
		writeSSEChunk(c, chatCompletionResponse{
			ID: completionID, Object: "chat.completion.chunk", Model: ModelID,
			Choices: []chatCompletionChoice{{Delta: &chatMessage{Role: "assistant", Content: reply}}},
		})
		writeSSEChunk(c, chatCompletionResponse{
			ID: completionID, Object: "chat.completion.chunk", Model: ModelID,
			Choices: []chatCompletionChoice{{Delta: &chatMessage{}, FinishReason: &stop}},
		})
		fmt.Fprint(c.Writer, "data: [DONE]\n\n")
		c.Writer.Flush()
		return
	}

	c.JSON(http.StatusOK, chatCompletionResponse{
		ID: completionID, Object: "chat.completion", Model: ModelID,
		Choices: []chatCompletionChoice{
			{Message: &chatMessage{Role: "assistant", Content: reply}, FinishReason: &stop},
		},
	})
}

func writeSSEChunk(c *gin.Context, chunk chatCompletionResponse) {
	payload, _ := json.Marshal(chunk)
	fmt.Fprintf(c.Writer, "data: %s\n\n", payload)
	c.Writer.Flush()
}

// splitMessages returns the LAST user message as the turn, every prior
// user/assistant message as seed history (bounded, system dropped), and the
// index of that user message.
//
// The last user message is found by scanning backwards rather than taking the
// final element, because a client resuming a tool call sends
// user → assistant(tool_calls) → tool(result) — the user turn is no longer last.
// The index is what lets prior tool calls be collected from exactly the
// messages that belong to the exchange in flight.
func splitMessages(messages []callertools.WireMessage) (string, []workflows.ChatMessage, int, error) {
	lastUser := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			lastUser = i
			break
		}
	}
	userContent := ""
	if lastUser >= 0 {
		userContent = messageContent(messages[lastUser].Content)
	}
	if lastUser < 0 || strings.TrimSpace(userContent) == "" {
		return "", nil, -1, fmt.Errorf("messages must contain a non-empty user message")
	}

	var history []workflows.ChatMessage
	for _, m := range messages[:lastUser] {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		content := messageContent(m.Content)
		if strings.TrimSpace(content) == "" {
			continue // an assistant message carrying only tool_calls has none
		}
		history = append(history, workflows.ChatMessage{Role: m.Role, Content: content})
	}
	if len(history) > maxSeedHistoryMessages {
		history = history[len(history)-maxSeedHistoryMessages:]
	}
	return userContent, history, lastUser, nil
}

// messageContent reads a message's content, tolerating the multi-part array
// form some clients send instead of a plain string.
func messageContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				b.WriteString(p.Text)
			}
		}
		return b.String()
	}
	return ""
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
				if len(d.result.PendingToolCalls) > 0 {
					// One delta carrying the whole array: the planner produces
					// arguments in one shot, so there is nothing to stream
					// incrementally.
					reason := "tool_calls"
					writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{
						Delta: &chatMessage{Role: "assistant", ToolCalls: toolCallsPayload(d.result.PendingToolCalls)},
					}}})
					writeChunk(chatCompletionResponse{Choices: []chatCompletionChoice{{Delta: &chatMessage{}, FinishReason: &reason}}})
					fmt.Fprint(c.Writer, "data: [DONE]\n\n")
					c.Writer.Flush()
					return
				}
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
