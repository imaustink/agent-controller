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

// invokeRequest is the /invoke contract (ADR 0006), in two shapes:
//
//   - A RESOLVED turn, from agent-orchestrator: it owns EventTrigger matching
//     for its own engine mode, matched the event already, and forwards the
//     result — forcedSkillId | forcedAgentId | forcedToolId, toolInput,
//     readOnly, params, triggerName, the rendered prompt as `request`, and
//     targetRepository. Nothing is matched here: re-deciding a dispatch the
//     caller already made could only disagree with it.
//   - A raw `event` envelope from a direct caller (docs/event-triggers.md §5),
//     matched here against the EventTrigger registry.
//
// A plain chat-style call is the first shape with no forced target.
type invokeRequest struct {
	Request   string `json:"request"`
	SessionID string `json:"sessionId"`
	// SessionIDSnake is §5's spelling for direct callers; sessionId (what
	// agent-orchestrator sends) wins when both are present.
	SessionIDSnake string `json:"session_id"`

	// Event is the normalized envelope (§2). Only a direct caller sends it.
	Event *catalog.Envelope `json:"event"`

	// The resolved turn. Every one of these is a dispatch instruction, never
	// an authorization: the workflow re-resolves the named target under the
	// caller's own roles and fails the turn on a miss.
	ForcedSkillID string `json:"forcedSkillId,omitempty"`
	ForcedAgentID string `json:"forcedAgentId,omitempty"`
	ForcedToolID  string `json:"forcedToolId,omitempty"`
	// ToolInput is a forced tool's one string input (§1).
	ToolInput string `json:"toolInput,omitempty"`
	// ReadOnly can only restrict, so it is honoured from any caller.
	ReadOnly    bool              `json:"readOnly,omitempty"`
	Params      map[string]string `json:"params,omitempty"`
	TriggerName string            `json:"triggerName,omitempty"`

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

	// IdentityLinkFlow lets a headless caller (e.g. integration-gateway's
	// relay, which has no browser to redirect) request the device OAuth flow
	// instead of the default authcode one. An absent or invalid value is
	// silently ignored — the workflow's own "authcode" default applies —
	// rather than 400ing the whole request. identity_link_flow is §5's
	// spelling for direct callers.
	IdentityLinkFlow      string `json:"identityLinkFlow,omitempty"`
	IdentityLinkFlowSnake string `json:"identity_link_flow,omitempty"`

	// TargetRepository is the "owner/name" an event fired on, named by an
	// adapter that already read it off the event (agent-orchestrator sends
	// envelope.repository). Absent, a matched envelope's own repository is
	// used.
	TargetRepository string `json:"targetRepository,omitempty"`
}

type invokeAccepted struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	// Trigger is set only for an event matched HERE (§5): which trigger won,
	// the session it runs in, and its reply side effects with every template
	// already rendered — what integration-gateway's reply adapters act on.
	Trigger *invokeTrigger `json:"trigger,omitempty"`
}

type invokeTrigger struct {
	Name      string `json:"name"`
	SessionID string `json:"sessionId"`
	// Reply is null, not absent, when the trigger declares none.
	Reply *catalog.RenderedReply `json:"reply"`
}

// invokeOutcome is a non-turn /invoke answer (§5): "ignored" (200) or
// "failed" (422).
type invokeOutcome struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type invokeRecord struct {
	ID     string `json:"id"`
	Status string `json:"status"` // pending | succeeded | failed
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
	// Path mirrors workflows.TurnMeta.Path on a "succeeded" record — in
	// particular, "link-required" is what distinguishes a turn that PARKED
	// waiting on an account link from one that is genuinely done. Without
	// this a polling caller (agent-orchestrator's TemporalEngine) cannot
	// tell the two apart and has no way to keep a live caller's turn open
	// across an automatic resume attempt.
	Path string `json:"path,omitempty"`
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
	invokeStatusIgnored   = "ignored"
)

// invokePollTimeout bounds how long a GET waits before answering "pending".
// The SDK's update handle has no peek, so a poll is a Get with a short
// deadline; long enough that a turn finishing right now is reported as
// finished, short enough not to hold the adapter's connection.
const invokePollTimeout = 2 * time.Second

var (
	// errEmptyRequest is the one shaping failure a caller can fix by sending text.
	errEmptyRequest = errors.New(`body must be JSON: {"request": "<non-empty string>"} or {"event": <envelope>}`)
	// errNotAnEnvelope rejects the retired IntegrationRoute descriptor shape
	// ({source, event, action, …}) loudly instead of matching nothing.
	errNotAnEnvelope = errors.New(`event must be an event envelope with a "kind" (docs/event-triggers.md §2)`)
	// errAmbiguousTarget: a resolved turn names exactly one target.
	errAmbiguousTarget = errors.New("at most one of forcedSkillId, forcedAgentId, forcedToolId may be set")
	// errNoTriggers: this gateway has no EventTrigger table to match against.
	errNoTriggers = errors.New("event triggers are not configured on this gateway")
)

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

// shapedInvoke is an /invoke body turned into what happens next: a turn to
// run in sessionID, or (ignored) nothing at all.
type shapedInvoke struct {
	turn      workflows.TurnInput
	sessionID string
	// ignored: an event matched no trigger — a clean no-op, never a
	// retrieval fallback (a CI or Stripe webhook that matches nothing must not
	// be read as free text).
	ignored bool
	// match is the trigger matched HERE, if any; nil for a resolved turn.
	match *catalog.TriggerMatch
}

// shapeInvokeTurn turns an /invoke body into the turn the workflow runs:
// resolves who the adapter is vouching for, and either takes the caller's
// resolved dispatch as-is or matches the event envelope against the trigger
// table.
//
// Separated from the handler because everything security-relevant about
// /invoke lives here — which login is trusted, and from where. A
// *catalog.MatchError return is a matched trigger that failed (422).
func shapeInvokeTurn(
	req invokeRequest,
	assertionHeader, assertionSecret string,
	triggers *catalog.EventTriggerRegistry,
	caller activities.Caller,
	now time.Time,
) (shapedInvoke, error) {
	if req.Event != nil && strings.TrimSpace(req.Event.Kind) == "" {
		return shapedInvoke{}, errNotAnEnvelope
	}

	// Read the sender login OUTSIDE trigger matching, deliberately: the
	// principal must resolve for every event-driven turn, whichever way it
	// was dispatched. Gating it on a match would make cross-entry-point
	// credential sharing quietly depend on trigger config.
	//
	// WHERE it is trusted from depends on configuration (upstream ADR 0030
	// §6). With a secret configured, ONLY a signed assertion is accepted and
	// the envelope's sender is ignored entirely — otherwise anything holding
	// this endpoint's token could name an arbitrary login and be handed that
	// person's credentials.
	var senderLogin string
	if assertionSecret != "" {
		senderLogin = rbac.VerifySenderAssertion(assertionSecret, assertionHeader, now)
	} else if req.Event != nil {
		if raw, ok := req.Event.Sender["login"].(string); ok {
			senderLogin = strings.TrimSpace(raw)
		}
	}

	// Power-user/headless-caller convenience field, not required — an
	// absent or invalid value is silently ignored (the workflow's own
	// "authcode" default applies) rather than 400ing the whole request.
	var identityLinkFlow string
	for _, flow := range []string{req.IdentityLinkFlow, req.IdentityLinkFlowSnake} {
		if flow == "device" || flow == "authcode" {
			identityLinkFlow = flow
			break
		}
	}

	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(req.SessionIDSnake)
	}

	turn := workflows.TurnInput{
		Caller:           caller,
		SenderLogin:      senderLogin,
		IdentityLinkFlow: identityLinkFlow,
		TargetRepository: strings.TrimSpace(req.TargetRepository),
	}

	forced := 0
	for _, id := range []string{req.ForcedSkillID, req.ForcedAgentID, req.ForcedToolID} {
		if id != "" {
			forced++
		}
	}
	if forced > 1 {
		return shapedInvoke{}, errAmbiguousTarget
	}

	// A resolved turn: the caller already did the matching (or there is none
	// to do), and re-deciding it here could only disagree. An accompanying
	// envelope contributes nothing but the sender above and its repository.
	if forced == 1 || req.Event == nil {
		turn.Message = strings.TrimSpace(req.Request)
		turn.ForcedSkillID = req.ForcedSkillID
		turn.ForcedAgentID = req.ForcedAgentID
		turn.ForcedToolID = req.ForcedToolID
		turn.ToolInput = req.ToolInput
		turn.ReadOnly = req.ReadOnly
		turn.Params = req.Params
		turn.TriggerName = req.TriggerName
		if turn.TargetRepository == "" && req.Event != nil {
			turn.TargetRepository = strings.TrimSpace(req.Event.Repository)
		}
		// A forced tool's input is ToolInput, so its prompt may legitimately
		// be empty (a toolRef trigger needs no promptTemplate). Anything else
		// with nothing to say is a malformed request.
		if turn.Message == "" && turn.ForcedToolID == "" {
			return shapedInvoke{}, errEmptyRequest
		}
		return shapedInvoke{turn: turn, sessionID: sessionID}, nil
	}

	// A raw envelope from a direct caller: match it here (§4).
	if triggers == nil {
		return shapedInvoke{}, errNoTriggers
	}
	m, err := triggers.Match(*req.Event, sessionID)
	if err != nil {
		return shapedInvoke{}, err
	}
	if m == nil {
		log.Printf("/invoke event %s/%s matched no trigger; ignored", req.Event.Source, req.Event.ID)
		return shapedInvoke{ignored: true}, nil
	}

	target := m.Trigger.Spec.Target
	turn.Message = m.Prompt
	turn.ForcedSkillID = target.SkillRef
	turn.ForcedAgentID = target.AgentRef
	turn.ForcedToolID = target.ToolRef
	if target.ToolRef != "" {
		turn.ToolInput = m.ToolInput
	}
	// A caller may add read-only on top of the trigger's; never remove it.
	turn.ReadOnly = target.ReadOnly || req.ReadOnly
	turn.Params = m.StringParams
	turn.TriggerName = m.Trigger.Name
	// The repository the source's sender was verified on (§2 repositoryFrom)
	// — never one read out of the prompt.
	if turn.TargetRepository == "" {
		turn.TargetRepository = strings.TrimSpace(req.Event.Repository)
	}
	log.Printf("/invoke event %s/%s matched trigger %s: skill=%q agent=%q tool=%q readOnly=%t",
		req.Event.Source, req.Event.ID, m.Trigger.Name, turn.ForcedSkillID, turn.ForcedAgentID, turn.ForcedToolID, turn.ReadOnly)
	return shapedInvoke{turn: turn, sessionID: m.SessionID, match: m}, nil
}

func (s *Server) handleInvoke(c *gin.Context) {
	var req invokeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, errEmptyRequest.Error())
		return
	}

	shaped, err := shapeInvokeTurn(
		req,
		c.GetHeader(rbac.SenderAssertionHeader),
		s.senderAssertionSecret,
		s.triggers,
		s.resolveInvokeCaller(c),
		time.Now(),
	)
	var matchErr *catalog.MatchError
	switch {
	case errors.As(err, &matchErr):
		// Matched, then params or a template failed: the event fails here and
		// never becomes a turn with a silently empty value in it.
		log.Printf("/invoke: %v", matchErr)
		c.JSON(http.StatusUnprocessableEntity, invokeOutcome{Status: invokeStatusFailed, Error: matchErr.Error()})
		return
	case errors.Is(err, errNoTriggers):
		writeError(c, http.StatusServiceUnavailable, err.Error())
		return
	case err != nil:
		writeError(c, http.StatusBadRequest, err.Error())
		return
	case shaped.ignored:
		c.JSON(http.StatusOK, invokeOutcome{Status: invokeStatusIgnored})
		return
	}
	turn := shaped.turn

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

	sessionID := shaped.sessionID
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

	accepted := invokeAccepted{ID: encodeInvocationID(workflowID, updateID), Status: invokeStatusPending}
	if m := shaped.match; m != nil {
		accepted.Trigger = &invokeTrigger{Name: m.Trigger.Name, SessionID: sessionID, Reply: m.Reply}
	}
	c.JSON(http.StatusAccepted, accepted)
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
			Path:             result.Meta.Path,
			ToolCalls:        result.PendingToolCalls,
			RemoteControlUrl: result.Meta.RemoteControlUrl,
		})

	case ctx.Err() != nil && c.Request.Context().Err() == nil, isTransportTimeoutOrCancel(err):
		// Either our own invokePollTimeout lapsed, or the SDK's long-poll gRPC
		// call was itself cancelled/timed out (WorkflowUpdateServiceTimeoutOr
		// CanceledError -- e.g. "stream terminated by RST_STREAM with error
		// code: CANCEL"). The SDK documents that error as being about the
		// client call, NOT the update: the workflow is still running either
		// way. Reporting it as "failed" here made agent-orchestrator surface
		// a bridged coding agent's routine multi-minute turn as an outright
		// failure while the AgentRun kept working in the background.
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

// isTransportTimeoutOrCancel reports whether err is the SDK's
// WorkflowUpdateServiceTimeoutOrCanceledError (e.g. wrapping "stream
// terminated by RST_STREAM with error code: CANCEL") -- a gRPC long-poll call
// that got cancelled or timed out on its own terms, independent of our
// invokePollTimeout ever firing. The SDK's own doc comment on the type is
// explicit that this is "not related to any general concept of timing out or
// cancelling a running update": the workflow update itself is unaffected.
// See awaitTurnResult in server.go for the streaming endpoint's analogous fix.
func isTransportTimeoutOrCancel(err error) bool {
	var pollErr *client.WorkflowUpdateServiceTimeoutOrCanceledError
	return errors.As(err, &pollErr)
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
