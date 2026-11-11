package activities

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
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

// traceOf is the trace an activity runs in: its id, and the W3C traceparent a
// launched run continues. Empty when tracing is off.
func traceOf(ctx context.Context) (traceID, traceparent string) {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return "", ""
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	return sc.TraceID().String(), carrier.Get("traceparent")
}

// TraceUser is the person a trace is attributed to in Langfuse (docs/adr/0050
// §1): the human the run acted for -- a webhook sender's delegated subject,
// else the verified sender, else the authenticated caller.
func TraceUser(l audit.Launch) string {
	switch {
	case l.DelegatedSubject != "":
		return l.DelegatedSubject
	case l.Sender != nil && l.Sender.Login != "":
		provider := l.Sender.Provider
		if provider == "" {
			provider = "github"
		}
		return provider + ":" + l.Sender.Login
	default:
		return l.LaunchedBy
	}
}

// annotateIdentity puts the launch's identity on the current span as the
// audit record states it (docs/adr/0050 §1), so a trace names who it acted
// for and as what, and an audit record's traceId finds it. Langfuse reads
// langfuse.user.id / session.id / trace.tags as trace-level fields.
func annotateIdentity(ctx context.Context, l audit.Launch, conversation string) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	attrs := []attribute.KeyValue{
		attribute.String("langfuse.user.id", TraceUser(l)),
		attribute.String("aktis.launched_by", l.LaunchedBy),
		attribute.String("aktis.entry_point", l.EntryPoint),
		attribute.Bool("aktis.read_only", l.ReadOnly),
	}
	if conversation != "" {
		attrs = append(attrs, attribute.String("langfuse.session.id", conversation))
	}
	tags := []string{}
	if l.IdentityMode != "" {
		attrs = append(attrs, attribute.String("aktis.identity_mode", l.IdentityMode))
		tags = append(tags, "identity:"+l.IdentityMode)
	}
	if l.IdentityModeSource != "" {
		attrs = append(attrs, attribute.String("aktis.identity_mode_source", l.IdentityModeSource))
	}
	if l.EntryPoint != "" {
		tags = append(tags, "entry:"+l.EntryPoint)
	}
	if l.Trigger != "" {
		attrs = append(attrs, attribute.String("aktis.trigger", l.Trigger))
	}
	if l.Sender != nil && l.Sender.Login != "" {
		attrs = append(attrs, attribute.String("aktis.sender", l.Sender.Provider+":"+l.Sender.Login))
	}
	if len(tags) > 0 {
		attrs = append(attrs, attribute.StringSlice("langfuse.trace.tags", tags))
	}
	span.SetAttributes(attrs...)
}
