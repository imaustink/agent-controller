package gateway

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.temporal.io/api/serviceerror"

	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

// maxCallbackBody bounds event payloads well under Temporal's ~2MB payload
// limit (large results belong in artifacts, not inline).
const maxCallbackBody = 1 << 20

// WorkflowSignaler is the slice of client.Client the bridge needs.
type WorkflowSignaler interface {
	SignalWorkflow(ctx context.Context, workflowID, runID, signalName string, arg any) error
}

// CallbackServer translates tool-Job HMAC callbacks into workflow signals.
// It listens on its own port so operators can keep it cluster-internal while
// exposing the chat facade more broadly (agent-controller ADR 0006's
// two-listener split, preserved).
type CallbackServer struct {
	signaler WorkflowSignaler
	secret   string
}

func NewCallbackServer(signaler WorkflowSignaler, secret string) *CallbackServer {
	return &CallbackServer{signaler: signaler, secret: secret}
}

func (s *CallbackServer) Handler() http.Handler {
	router := gin.New()
	router.Use(gin.Recovery())
	router.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	router.POST("/callback/:workflowID/:jobID", s.handleCallback)
	return router
}

func (s *CallbackServer) handleCallback(c *gin.Context) {
	workflowID := c.Param("workflowID")
	jobID := c.Param("jobID")

	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, maxCallbackBody+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "read body: " + err.Error()})
		return
	}
	if len(raw) > maxCallbackBody {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "event exceeds 1MiB; ship large results as artifacts"})
		return
	}

	// Signature over the exact raw body, before any parsing.
	if err := messaging.Verify(s.secret, raw, c.GetHeader(messaging.SignatureHeader)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "signature verification failed"})
		return
	}

	event, err := messaging.ParseEvent(raw)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Correlation is by URL path, deliberately (the URL was minted by us and
	// carried through the CR; the body is tool-authored). A mismatched body
	// job_id is suspicious but non-fatal.
	if event.JobID != jobID {
		log.Printf("callback body job_id %q != path job id %q (workflow %s); trusting path", event.JobID, jobID, workflowID)
		event.JobID = jobID
	}

	err = s.signaler.SignalWorkflow(c.Request.Context(), workflowID, "", workflows.ToolEventSignalPrefix+jobID, event)
	if err != nil {
		var notFound *serviceerror.NotFound
		if errors.As(err, &notFound) {
			// Workflow gone (completed/timed out) — a late event has nowhere
			// to go; tell the sink not to bother retrying.
			c.JSON(http.StatusGone, gin.H{"error": "workflow no longer running"})
			return
		}
		log.Printf("signal %s to workflow %s failed: %v", event.Type, workflowID, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to deliver event"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"delivered": event.Type, "seq": event.Seq})
}
