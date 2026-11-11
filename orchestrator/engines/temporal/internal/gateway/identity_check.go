package gateway

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.temporal.io/sdk/client"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
	"github.com/aktisai/orchestrator/engines/temporal/internal/rbac"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/workflows"
)

// identityCheckTimeout bounds the accept-phase check. A webhook sender's
// delivery timeout is ~10 s; past this the gateway answers "no objection" and
// the run's own pre-flight decides, refusing the same way.
const identityCheckTimeout = 4 * time.Second

// identityRefusal is the 403 body (docs/adr/0049 §6). Error is the
// IdentityError plus, for a matched trigger, its rendered reply -- so a relay
// can post the message where the sender will see it (reply.github.onIdentityError).
type identityRefusal struct {
	Status string             `json:"status"`
	Error  identityErrorReply `json:"error"`
}

type identityErrorReply struct {
	*authz.IdentityError
	Trigger *invokeTrigger `json:"trigger,omitempty"`
}

// checkIdentity runs the accept-phase identity check for a turn that names
// its agent up front (an agentRef trigger). Only a webhook sender's turn can
// fail it: a chat caller has a live channel to be prompted on. Nil: no
// objection, including whenever the check cannot run.
func (s *Server) checkIdentity(ctx context.Context, turn workflows.TurnInput) *authz.IdentityError {
	if turn.ForcedAgentID == "" || turn.Caller.PerUser || turn.SenderLogin == "" || s.temporal == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, identityCheckTimeout)
	defer cancel()
	run, err := s.temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       "identity-check-" + uuid.NewString(),
		TaskQueue:                s.taskQueue,
		WorkflowExecutionTimeout: identityCheckTimeout,
	}, workflows.IdentityCheckWorkflowName, workflows.IdentityCheckInput{
		Caller:              turn.Caller,
		AgentID:             turn.ForcedAgentID,
		IdentityOverride:    turn.IdentityOverride,
		SenderLogin:         turn.SenderLogin,
		DelegatedSubject:    turn.DelegatedSubject,
		SenderAccountID:     turn.SenderAccountID,
		SenderSubjectStatus: turn.SenderSubjectStatus,
	})
	if err != nil {
		log.Printf("identity check for %s: could not start (%v); deferring to the run's pre-flight", turn.ForcedAgentID, err)
		return nil
	}
	var ie *authz.IdentityError
	if err := run.Get(ctx, &ie); err != nil {
		log.Printf("identity check for %s: no answer (%v); deferring to the run's pre-flight", turn.ForcedAgentID, err)
		return nil
	}
	return ie
}

func refuseIdentity(c *gin.Context, ie *authz.IdentityError, match *catalog.TriggerMatch, sessionID string) {
	// docs/adr/0050 §4: a refused delivery is a short trace ending in an
	// error span carrying the code, so "how often do senders hit the link
	// wall" is a query, not log archaeology.
	span := trace.SpanFromContext(c.Request.Context())
	span.SetStatus(codes.Error, ie.Code)
	attrs := []attribute.KeyValue{attribute.String("aktis.identity_error", ie.Code)}
	if ie.Target != nil {
		attrs = append(attrs, attribute.String("aktis.agent", ie.Target.Name))
	}
	if ie.Sender != nil {
		attrs = append(attrs, attribute.String("aktis.sender", ie.Sender.Provider+":"+ie.Sender.Login))
	}
	span.SetAttributes(attrs...)

	body := identityRefusal{Status: invokeStatusFailed, Error: identityErrorReply{IdentityError: ie}}
	if match != nil {
		body.Error.Trigger = &invokeTrigger{Name: match.Trigger.Name, SessionID: sessionID, Reply: match.Reply}
	}
	c.JSON(http.StatusForbidden, body)
}

// handleInvokeCheck is /invoke's accept-phase identity check on its own, for
// agent-orchestrator: it accepts a trigger turn and answers 202 before it ever
// reaches this engine, so it asks first (docs/adr/0049 §6). Same body and
// headers as /invoke. 204: no objection. 403: the identity error.
func (s *Server) handleInvokeCheck(c *gin.Context) {
	var req invokeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, errEmptyRequest.Error())
		return
	}
	shaped, err := shapeInvokeTurn(
		req,
		c.GetHeader(rbac.SenderAssertionHeader),
		c.GetHeader(rbac.DispatchAssertionHeader),
		s.senderAssertionSecret,
		s.triggers,
		s.resolveInvokeCaller(c),
		time.Now(),
	)
	if err != nil || shaped.ignored {
		// Not this endpoint's to judge: /invoke itself answers these.
		c.Status(http.StatusNoContent)
		return
	}
	if ie := s.checkIdentity(c.Request.Context(), shaped.turn); ie != nil {
		refuseIdentity(c, ie, shaped.match, shaped.sessionID)
		return
	}
	c.Status(http.StatusNoContent)
}
