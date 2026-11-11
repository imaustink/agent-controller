package activities

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
)

// annotatePreflightSpan puts the pre-flight's verdict on the Authorize
// activity's own span -- the one the Temporal tracing interceptor already
// opened (docs/adr/0050 §3a). Names and modes only; a verdict carries no
// credential material by construction (see internal/authz).
func annotatePreflightSpan(ctx context.Context, in AuthorizeInput, v authz.Verdict) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	attrs := []attribute.KeyValue{
		attribute.String("aktis.agent", in.AgentID),
		attribute.String("aktis.preflight.verdict", string(v.Kind)),
		attribute.String("aktis.decision_id", v.DecisionID),
	}
	if v.RequestedIdentityMode != "" {
		attrs = append(attrs,
			attribute.String("aktis.identity_mode.requested", string(v.RequestedIdentityMode)),
			attribute.String("aktis.identity_mode_source", string(v.IdentityModeSource)))
	}
	if v.IdentityMode != "" {
		attrs = append(attrs, attribute.String("aktis.identity_mode", string(v.IdentityMode)))
	}
	if v.IdentityError != nil {
		attrs = append(attrs, attribute.String("aktis.identity_error", v.IdentityError.Code))
	}
	span.SetAttributes(attrs...)
}
