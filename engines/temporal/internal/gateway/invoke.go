package gateway

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/rbac"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

// The async accept/poll interface an adapter (integration-gateway) uses for a
// turn that may take minutes: POST /invoke returns an id immediately, GET
// /invoke/:id reports on it.
//
// Upstream keeps the invocation record in an in-process Map, and its ADR 0006
// documents the resulting restart/scale-out loss; ADR 0033 closes by saying
// the interrupted turn itself is still lost and that fixing it "means durable
// invocation records, which this does not attempt". Here there is no record
// to lose: the id names a workflow update, so a poll is answered from
// Temporal. Any gateway replica can serve it, and a gateway that dies
// mid-turn costs the caller nothing — the turn is still running, and the
// answer is still collectable afterwards.
//
// The bound worth knowing: an update result is readable while its workflow
// is retained. A conversation that idles out (30 min) and completes takes its
// updates with it, so a caller that never polls eventually loses the answer —
// vastly longer than a pod's lifetime, but not forever.

// invokeRequest is upstream's /invoke contract: a single request string plus
// the optional event descriptor an adapter attaches when the trigger already
// names an unambiguous target (ADR 0024).
type invokeRequest struct {
	Request   string         `json:"request"`
	SessionID string         `json:"sessionId"`
	Event     map[string]any `json:"event"`

	// ForcedSkillID / ForcedAgentID let a caller that has ALREADY matched a
	// route name the target directly, instead of sending the event descriptor
	// and having it matched here again.
	//
	// This is how the TypeScript orchestrator drives this engine: it owns the
	// IntegrationRoute registry, so re-matching here would put routing policy in
	// two places — the duplication ADR 0024 rejected when it declined to let the
	// gateway launch AgentRuns directly. They are still only a routing hint: the
	// workflow re-resolves whatever is named under the caller's own roles.
	ForcedSkillID string `json:"forcedSkillId,omitempty"`
	ForcedAgentID string `json:"forcedAgentId,omitempty"`

	// CallerTools / CallerToolRequired carry a chat turn's caller-supplied
	// tools (ADR 0035) across this hop, already parsed, validated and ranked
	// by agent-orchestrator's own handleChat before it ever calls
	// TemporalEngine.invoke() -- so this is the resolved Descriptor shape, not
	// the raw OpenAI `tools`/`tool_choice` request body callertools.Parse
	// consumes. Re-parsing/re-ranking here would duplicate work already done
	// (a second, redundant Qdrant rank against a fresh top-K) and there is no
	// raw tool list left to re-parse by this point in agent-orchestrator's own
	// pipeline. Omitting these silently drops every caller tool for any turn
	// routed through /invoke, regardless of what the original chat request
	// offered.
	CallerTools        []callertools.Descriptor `json:"callerTools,omitempty"`
	CallerToolRequired bool                     `json:"callerToolRequired,omitempty"`

	// PriorCallerToolCalls are calls the client already executed and reported
	// back (ADR 0035 resume), forwarded verbatim from agent-orchestrator's own
	// `actionHistory` -- there is no raw message array at this hop for
	// callertools.CollectPriorCalls to parse, unlike handleChat talking
	// directly to a client.
	PriorCallerToolCalls []callertools.PriorCall `json:"priorCallerToolCalls,omitempty"`
}

type invokeAccepted struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type invokeRecord struct {
	ID     string `json:"id"`
	Status string `json:"status"` // pending | succeeded | failed
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
	// ToolCalls renders the second terminal shape (ADR 0035) for a polling
	// adapter. Offering caller tools over /invoke works, but the round-trip
	// resume does not: /invoke takes a single request string, not a message
	// array, so a caller has nowhere to put the result. Reported so an adapter
	// sees a real outcome rather than an empty success.
	ToolCalls []callertools.PendingCall `json:"toolCalls,omitempty"`
	// Progress carries the in-flight turn's narration lines (workflows.
	// TurnProgressQuery), same source streamTurn already polls for the
	// gateway's own native SSE endpoint -- surfaced here too so a caller
	// using the accept/poll /invoke contract (agent-orchestrator's
	// TemporalEngine) can render live status instead of going silent until
	// the turn completes. Only ever set on a "pending" record.
	Progress []string `json:"progress,omitempty"`
	// RemoteControlUrl mirrors workflows.TurnProgress.RemoteControlUrl /
	// TurnMeta.RemoteControlUrl -- a live Remote Control session URL, set on
	// BOTH a "pending" record (as soon as the episode reports one) and the
	// terminal "succeeded" record (from TurnResult.Meta), so a caller does
	// not have to catch it mid-poll before the turn completes. Only ever set
	// when the delegated agent actually emits one (today: claude-code-swe-agent).
	RemoteControlUrl string `json:"remoteControlUrl,omitempty"`
}

const (
	invokeStatusPending   = "pending"
	invokeStatusSucceeded = "succeeded"
	invokeStatusFailed    = "failed"
)

// invokePollTimeout bounds how long a GET waits before answering "pending".
// The SDK's update handle has no peek, so a poll is a Get with a short
// deadline; long enough that a turn finishing right now is reported as
// finished, short enough not to hold the adapter's connection.
const invokePollTimeout = 2 * time.Second

// errEmptyRequest is the one shaping failure a caller can fix.
var errEmptyRequest = errors.New(`body must be JSON: {"request": "<non-empty string>"}`)

// resolveInvokeCaller prefers a trusted, signed caller identity
// (rbac.CallerIdentityHeader) over this gateway's own bearer-token
// resolution, when present and valid.
//
// Every /invoke caller today is agent-orchestrator, authenticating with ONE
// shared service token (or none). Bearer resolution alone therefore collapses
// every Open WebUI user, and every webhook sender, onto the SAME subject --
// agent-orchestrator has ALREADY resolved the real per-request identity
// itself (OIDC/static/forwarded-user-JWT) before this hop, and this header is
// how it proves that to the gateway instead of the gateway re-deriving it
// from a token it was never given.
func (s *Server) resolveInvokeCaller(c *gin.Context) activities.Caller {
	caller := resolveCaller(c, s.identity)
	if subject, roles, perUser := rbac.VerifyCallerIdentityAssertion(s.senderAssertionSecret, c.GetHeader(rbac.CallerIdentityHeader), time.Now()); subject != "" {
		caller.Subject = subject
		caller.Roles = roles
		caller.PerUser = perUser
	}
	return caller
}

// shapeInvokeTurn turns an /invoke body into the turn the workflow runs:
// resolves who the adapter is vouching for, matches the event against the
// route table, and renders the matched route's prompt.
//
// Separated from the handler because everything security-relevant about
// /invoke lives here — which login is trusted, and from where.
func shapeInvokeTurn(
	req invokeRequest,
	assertionHeader, assertionSecret string,
	routes *catalog.RouteRegistry,
	caller activities.Caller,
	now time.Time,
) (workflows.TurnInput, error) {
	request := strings.TrimSpace(req.Request)

	// Read the sender login OUTSIDE the route match, deliberately: the
	// principal must resolve for every event-driven turn, including ones that
	// match no route and fall back to retrieval. Gating it on a route match
	// would make cross-entry-point credential sharing quietly depend on
	// routing config.
	//
	// WHERE it is trusted from depends on configuration (upstream ADR 0030
	// §6). With a secret configured, ONLY a signed assertion is accepted and
	// the body field is ignored entirely — otherwise anything holding this
	// endpoint's token could name an arbitrary login and be handed that
	// person's credentials.
	var senderLogin string
	if assertionSecret != "" {
		senderLogin = rbac.VerifySenderAssertion(assertionSecret, assertionHeader, now)
	} else if raw, ok := req.Event["senderLogin"].(string); ok {
		senderLogin = strings.TrimSpace(raw)
	}

	// An explicitly named target wins: the caller already did the matching, and
	// re-deciding it here could only disagree.
	forcedSkillID, forcedAgentID := req.ForcedSkillID, req.ForcedAgentID
	if forcedSkillID == "" && forcedAgentID == "" && routes != nil && len(req.Event) > 0 {
		fields := catalog.EventFields(req.Event)
		if source, event := fields["source"], fields["event"]; source != "" && event != "" {
			if route, ok := routes.Match(source, event, fields["action"], fields["labelName"]); ok {
				request = catalog.RenderPromptTemplate(route.PromptTemplate, fields)
				forcedSkillID, forcedAgentID = route.SkillRef, route.AgentRef
				log.Printf("/invoke matched route %s: skill=%q agent=%q", route.ID, forcedSkillID, forcedAgentID)
			}
		}
	}

	// Checked after rendering: a route's promptTemplate legitimately supplies
	// the whole request, so an event-driven caller need not send request text
	// of its own.
	if request == "" {
		return workflows.TurnInput{}, errEmptyRequest
	}

	return workflows.TurnInput{
		Message:       request,
		Caller:        caller,
		SenderLogin:   senderLogin,
		ForcedSkillID: forcedSkillID,
		ForcedAgentID: forcedAgentID,
	}, nil
}

func (s *Server) handleInvoke(c *gin.Context) {
	var req invokeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, errEmptyRequest.Error())
		return
	}

	turn, err := shapeInvokeTurn(
		req,
		c.GetHeader(rbac.SenderAssertionHeader),
		s.senderAssertionSecret,
		s.routes,
		s.resolveInvokeCaller(c),
		time.Now(),
	)
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}

	// Already resolved by the caller (agent-orchestrator's handleChat, ADR
	// 0035) -- passed straight through, not re-parsed/re-ranked. See
	// invokeRequest.CallerTools's doc comment for why.
	if len(req.CallerTools) > 0 {
		turn.CallerTools = req.CallerTools
		turn.CallerToolRequired = req.CallerToolRequired
	}
	if len(req.PriorCallerToolCalls) > 0 {
		turn.PriorCallerToolCalls = req.PriorCallerToolCalls
	}

	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		sessionID = uuid.NewString()
	}
	workflowID := "conversation-" + sanitizeID(sessionID)
	updateID := uuid.NewString()

	startOp := s.temporal.NewWithStartWorkflowOperation(client.StartWorkflowOptions{
		ID:                       workflowID,
		TaskQueue:                s.taskQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
	}, workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))

	// Accepted, not Completed: /invoke is asynchronous by contract. Once the
	// update is admitted it is durable — the turn survives this process.
	if _, err := s.temporal.UpdateWithStartWorkflow(c.Request.Context(), client.UpdateWithStartWorkflowOptions{
		StartWorkflowOperation: startOp,
		UpdateOptions: client.UpdateWorkflowOptions{
			WorkflowID:   workflowID,
			UpdateID:     updateID,
			UpdateName:   workflows.UserTurnUpdate,
			WaitForStage: client.WorkflowUpdateStageAccepted,
			Args:         []any{turn},
		},
	}); err != nil {
		log.Printf("/invoke update-with-start failed: workflow=%s err=%v", workflowID, err)
		writeError(c, http.StatusBadGateway, "failed to reach conversation workflow: "+err.Error())
		return
	}

	c.JSON(http.StatusAccepted, invokeAccepted{ID: encodeInvocationID(workflowID, updateID), Status: invokeStatusPending})
}

func (s *Server) handleInvokeStatus(c *gin.Context) {
	id := c.Param("id")
	workflowID, updateID, ok := decodeInvocationID(id)
	if !ok {
		writeError(c, http.StatusBadRequest, "malformed invocation id")
		return
	}

	handle := s.temporal.GetWorkflowUpdateHandle(client.GetWorkflowUpdateHandleOptions{
		WorkflowID: workflowID,
		UpdateID:   updateID,
	})

	ctx, cancel := context.WithTimeout(c.Request.Context(), invokePollTimeout)
	defer cancel()

	var result workflows.TurnResult
	switch err := handle.Get(ctx, &result); {
	case err == nil:
		c.JSON(http.StatusOK, invokeRecord{
			ID: id, Status: invokeStatusSucceeded,
			Result:           result.Reply,
			ToolCalls:        result.PendingToolCalls,
			RemoteControlUrl: result.Meta.RemoteControlUrl,
		})

	case ctx.Err() != nil && c.Request.Context().Err() == nil:
		// Our own deadline, not the client's: the turn is simply still running.
		// Best-effort narration alongside it -- a query failure or an inactive
		// turn (nothing narrated yet) just means an empty Progress, never an
		// error response, since the pending status itself is still accurate.
		record := invokeRecord{ID: id, Status: invokeStatusPending}
		if resp, err := s.temporal.QueryWorkflow(c.Request.Context(), workflowID, "", workflows.TurnProgressQuery); err == nil {
			var progress workflows.TurnProgress
			if resp.Get(&progress) == nil && progress.Active {
				record.Progress = progress.Lines
				record.RemoteControlUrl = progress.RemoteControlUrl
			}
		}
		c.JSON(http.StatusOK, record)

	case isUnknownUpdate(err):
		writeError(c, http.StatusNotFound, "unknown invocation")

	default:
		// The turn itself failed. That is a completed invocation reporting a
		// failure, not a transport problem — 200 with status:failed, so an
		// adapter can tell "it went wrong" from "ask me again later".
		c.JSON(http.StatusOK, invokeRecord{ID: id, Status: invokeStatusFailed, Error: err.Error()})
	}
}

// isUnknownUpdate distinguishes an id naming nothing (the workflow aged out,
// or the caller made it up) from a turn that ran and failed.
func isUnknownUpdate(err error) bool {
	var notFound *serviceerror.NotFound
	return errors.As(err, &notFound)
}

// Invocation ids join the two halves Temporal needs to reconstruct an update
// handle. A '.' is unambiguous as the separator: sanitizeID maps everything
// outside [A-Za-z0-9_-] to '-', so the workflow id half never contains one,
// and the update id is a UUID.
func encodeInvocationID(workflowID, updateID string) string {
	return workflowID + "." + updateID
}

func decodeInvocationID(id string) (workflowID, updateID string, ok bool) {
	i := strings.LastIndex(id, ".")
	if i <= 0 || i == len(id)-1 {
		return "", "", false
	}
	return id[:i], id[i+1:], true
}
