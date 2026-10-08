package workflows

import (
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/agentrun"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// BridgedAgentWorkflow drives an UNMODIFIED agent-controller pod agent
// (claude-code-swe-agent, opencode-swe-agent) from a Temporal workflow.
//
// The agent runs as the AgentRun Job it always has, speaking the same
// bidirectional protocol to the same NATS subjects. What changes is which side
// of the conversation is durable: the wait lives here, not in a pod that a
// deploy can take out from under it.
//
// This is the third execution style, alongside the declarative AgentWorkflow
// and checkpoint-resume PodAgentWorkflow. Every one of them speaks the same
// parent-facing up/down signal protocol, so a conversation cannot tell them
// apart.
const BridgedAgentWorkflowName = "BridgedAgentWorkflow"

const (
	// bridgedRunTimeoutSeconds bounds the AgentRun Job. Coding agents are slow.
	bridgedRunTimeoutSeconds = 3600

	// bridgedReadyTimeout bounds the wait for the agent's `ready`.
	//
	// A pod that never becomes ready is an infrastructure problem, not a slow
	// agent: image pull failure, a crash loop, a missing credential. Bounding it
	// separately means those surface in a minute rather than an hour.
	bridgedReadyTimeout = 5 * time.Minute

	// defaultBridgedIdleTimeout is BridgedIdleTimeout's value until overridden.
	// Matches agent-orchestrator's own AGENT_IDLE_TIMEOUT_SECONDS default
	// (config.ts) — the two engines must agree, since a bridged agent's Job
	// speaks the identical NATS protocol regardless of which is driving the
	// episode.
	defaultBridgedIdleTimeout = 10 * time.Minute
)

// BridgedIdleTimeout bounds silence from a READY bridged agent. Upstream
// bounds a remote-control turn by silence rather than a stopwatch for the
// same reason: a working agent heartbeats, so quiet is diagnostic where
// elapsed time is not.
//
// A package-level var, not a const: cmd/worker/main.go overrides it from
// AGENT_IDLE_TIMEOUT_SECONDS once at process startup, before the worker
// starts polling for tasks. That single assignment happens-before any
// workflow task this process ever executes, so it never varies within an
// open workflow's history and introduces no non-determinism risk — the
// same discipline every other configured (as opposed to hardcoded) engine
// setting in cmd/worker/main.go already follows.
var BridgedIdleTimeout = defaultBridgedIdleTimeout

// BridgedAgentWorkflow runs one episode against a pod agent.
func BridgedAgentWorkflow(ctx workflow.Context, in AgentWorkflowInput) error {
	logger := workflow.GetLogger(ctx)
	selfID := workflow.GetInfo(ctx).WorkflowExecution.ID

	up := func(u AgentUp) {
		if err := workflow.SignalExternalWorkflow(ctx, in.ParentWorkflowID, "", AgentUpSignalPrefix+selfID, u).Get(ctx, nil); err != nil {
			logger.Warn("up-signal to parent failed", "parent", in.ParentWorkflowID, "error", err)
		}
	}
	fail := func(code, message string) error {
		up(AgentUp{Failed: true, Code: code, Message: message})
		return fmt.Errorf("%s: %s", code, message)
	}

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})

	// The agent's declared toolRefs, resolved once (ADR 0028). Unfiltered by
	// caller roles: the question is what the operator declared this agent may
	// call, not what the walk-in caller can reach.
	var declared []catalog.ToolDescriptor
	if len(in.Agent.ToolRefs) > 0 {
		if err := workflow.ExecuteActivity(actx, activities.ResolveAgentToolsActivityName, activities.ResolveAgentToolsInput{
			AgentID:  in.Agent.ID,
			ToolRefs: in.Agent.ToolRefs,
		}).Get(ctx, &declared); err != nil {
			logger.Warn("could not resolve the agent's declared toolRefs; tool_call will be refused",
				"agentId", in.Agent.ID, "error", err)
		}
	}

	var runID string
	if err := workflow.SideEffect(ctx, func(workflow.Context) any {
		// Also the protocol's agent_run_id, and therefore the NATS subjects.
		return newAgentRunName(in.Agent.ID)
	}).Get(&runID); err != nil {
		return fail("id_error", err.Error())
	}

	if err := workflow.ExecuteActivity(actx, activities.LaunchAgentRunActivityName, activities.LaunchAgentRunInput{
		RunID:                runID,
		AgentRef:             in.Agent.ID,
		Goal:                 in.Goal,
		WorkflowID:           selfID,
		TimeoutSeconds:       bridgedRunTimeoutSeconds,
		CredentialSecretName: in.Credentials.SecretName,
		CredentialEnvVars:    in.Credentials.EnvVars,
	}).Get(ctx, nil); err != nil {
		return fail("launch_error", err.Error())
	}
	// Release the bridge's subscription however this episode ends.
	defer func() {
		dctx, _ := workflow.NewDisconnectedContext(ctx)
		dctx = workflow.WithActivityOptions(dctx, workflow.ActivityOptions{
			StartToCloseTimeout: 15 * time.Second,
		})
		_ = workflow.ExecuteActivity(dctx, activities.DetachAgentRunActivityName, runID).Get(dctx, nil)
	}()

	upCh := workflow.GetSignalChannel(ctx, agentrun.UpSignalPrefix+runID)
	prompts := workflow.GetSignalChannel(ctx, AgentPromptSignal)

	send := func(in activities.AgentDownInput) error {
		in.RunID = runID
		return workflow.ExecuteActivity(actx, activities.SendAgentDownActivityName, in).Get(ctx, nil)
	}

	ready := false
	// Concluding messages can arrive more than once on the wire (ADR 0033's
	// re-offers reuse their seq). The bridge dedupes, but a workflow that
	// replays or re-attaches may still see one twice, so the terminal decision
	// is idempotent here too.
	handledSeq := map[int]bool{}

	for {
		timeout := BridgedIdleTimeout
		if !ready {
			timeout = bridgedReadyTimeout
		}

		var msg agentrun.UpMessage
		var received, timedOut bool
		timerCtx, cancelTimer := workflow.WithCancel(ctx)
		timer := workflow.NewTimer(timerCtx, timeout)

		selector := workflow.NewSelector(ctx)
		selector.AddReceive(upCh, func(c workflow.ReceiveChannel, _ bool) {
			c.Receive(ctx, &msg)
			received = true
		})
		selector.AddFuture(timer, func(workflow.Future) { timedOut = true })
		// A follow-up user turn arriving mid-episode goes straight down as the
		// next prompt — the agent is still running and holding its session.
		selector.AddReceive(prompts, func(c workflow.ReceiveChannel, _ bool) {
			var answer AgentPrompt
			c.Receive(ctx, &answer)
			if err := send(activities.AgentDownInput{Type: agentrun.DownPrompt, Message: answer.Message}); err != nil {
				logger.Warn("could not deliver prompt to agent", "runId", runID, "error", err)
			}
		})
		selector.Select(ctx)
		cancelTimer()

		if timedOut {
			// The CR's mirrored Job phase is the crash backstop, exactly as for
			// a tool: silence plus a terminal phase means the pod is gone, not
			// that the agent is thinking.
			var status any
			_ = workflow.ExecuteActivity(actx, activities.GetAgentRunPhaseActivityName, runID).Get(ctx, &status)
			_ = send(activities.AgentDownInput{Type: agentrun.DownCancel, Reason: "timed out"})
			if !ready {
				return fail("not_ready", fmt.Sprintf("agent %s never became ready within %s (AgentRun: %v)",
					in.Agent.ID, bridgedReadyTimeout, status))
			}
			// Milliseconds, matching upstream's nats-agent-channel.ts wording
			// exactly ("went silent for <N>ms") — the comment a human reads is
			// the only place this is observable (the gateway renders whatever
			// the workflow returns), so the wording is load-bearing, not
			// cosmetic.
			return fail("timeout", fmt.Sprintf("agent %s went silent for %dms (AgentRun: %v)",
				in.Agent.ID, BridgedIdleTimeout.Milliseconds(), status))
		}
		if !received {
			continue
		}

		switch msg.Type {
		case agentrun.UpReady:
			ready = true

		case agentrun.UpProgress, agentrun.UpWarning:
			line := msg.Message
			if msg.Stage != "" {
				line = msg.Stage + ": " + line
			}
			up(AgentUp{Progress: true, Message: line})

		case agentrun.UpToolCall:
			// A sub-agent calling a Tool from its own toolRefs (ADR 0028). The
			// dispatch is the ordinary one — this workflow runs the tool and
			// answers on the correlated callId.
			handleBridgedToolCall(ctx, actx, in, declared, runID, msg, send, up)

		case agentrun.UpReply:
			if handledSeq[msg.Seq] {
				continue // a re-offer we already acted on
			}
			handledSeq[msg.Seq] = true
			if msg.Final {
				up(AgentUp{Final: true, Message: msg.Message, Result: msg.ResultText()})
				return nil
			}
			// A non-final reply is a question. HITL has no dedicated message
			// pair: the question IS a reply, and the answer arrives as the next
			// prompt — deliberately, because a human may answer across chat
			// turns and no reply timeout can apply. Reported up so the parent
			// ends the turn with it; the next prompt signal continues.
			up(AgentUp{Message: msg.Message})

		case agentrun.UpFailed:
			if handledSeq[msg.Seq] {
				continue
			}
			handledSeq[msg.Seq] = true
			return fail(msg.Code, msg.Message)

		case agentrun.UpSessionEnded:
			// The agent is exiting. If it had anything conclusive to say it
			// already said it, so reaching here means it did not.
			return fail("session_ended", "the agent exited without a final reply: "+msg.Message)

		default:
			// opencode_event / session_idle / opencode_response: live-tunnel
			// traffic (ADR 0026) with no consumer here. Ignored rather than
			// treated as an error — an agent using the tunnel still emits an
			// ordinary final reply, which is the contract this workflow needs.
			logger.Debug("ignoring live-tunnel up-message", "type", msg.Type)
		}
	}
}

// k8sNameMaxBytes is the RFC 1123 label-value limit. This run name becomes a
// k8s AgentRun/Job name AND, via core-controller's reconciler (which uses it
// directly as the Job name), the API server's auto-added `job-name` label —
// so it must fit the LABEL limit (63 bytes), the stricter of the two, even
// though a bare resource name alone could run to 253.
const k8sNameMaxBytes = 63

// newAgentRunName builds this run's k8s-facing name (also the protocol's
// agent_run_id, and therefore the NATS subjects), truncating the agent ID —
// never the uuid — when the natural "agentrun-<agentId>-<uuid>" form would
// exceed k8sNameMaxBytes.
//
// This is not a hypothetical: "agentrun-" (9) + "claude-code-swe-agent" (21)
// + "-" (1) + a uuid.NewString() (36) is 67 bytes, already over the limit
// with today's actual agent ID -- core-controller's reconciler then rejects
// the Job it tries to create with "must be no more than 63 bytes" and the run
// never progresses past a bare AgentRun CR, retrying forever. e2e coverage
// missed this because its stand-in agent ("stub-agent", 10 chars) happens to
// fit; nothing this short-sightedly assumes a length bound in production.
func newAgentRunName(agentID string) string {
	suffix := uuid.NewString()
	name := "agentrun-" + agentID + "-" + suffix
	if len(name) <= k8sNameMaxBytes {
		return name
	}
	// Shorten the agent ID portion only -- the uuid is what makes this
	// unique, and truncating IT would reintroduce the collision risk the
	// full form exists to avoid.
	budget := k8sNameMaxBytes - len("agentrun-") - len("-") - len(suffix)
	if budget < 0 {
		budget = 0
	}
	if budget > len(agentID) {
		budget = len(agentID)
	}
	return "agentrun-" + agentID[:budget] + "-" + suffix
}

// handleBridgedToolCall runs a Tool on a sub-agent's behalf and answers the
// correlated callId.
//
// The gate applies here too: a Tool declaring identityProviders must not run
// credential-less merely because a pod agent asked for it rather than the
// planner.
func handleBridgedToolCall(
	ctx workflow.Context,
	actx workflow.Context,
	in AgentWorkflowInput,
	declared []catalog.ToolDescriptor,
	runID string,
	msg agentrun.UpMessage,
	send func(activities.AgentDownInput) error,
	up func(AgentUp),
) {
	answer := func(ok bool, result, errText string) {
		if err := send(activities.AgentDownInput{
			Type: agentrun.DownToolResult, CallID: msg.CallID,
			OK: ok, Result: result, Error: errText,
		}); err != nil {
			workflow.GetLogger(ctx).Warn("could not deliver tool_result",
				"runId", runID, "callId", msg.CallID, "error", err)
		}
	}

	// Re-validated against what the OPERATOR declared, at call time. The CRD
	// check upstream performs on these refs is a static-config sanity check,
	// not the authorization boundary — this is.
	tool := findToolByID(msg.Tool, declared)
	if tool == nil {
		answer(false, "", fmt.Sprintf("tool %q is not available to this agent", msg.Tool))
		return
	}

	// And the identity gate: a Tool declaring identityProviders must not run
	// credential-less merely because a pod agent asked for it rather than the
	// planner.
	creds, refusal := toolCredentials(ctx, actx, TurnInput{Caller: in.Caller}, *tool)
	if refusal != "" {
		answer(false, "", refusal)
		return
	}

	up(AgentUp{Progress: true, Message: "Running " + msg.Tool + "…"})
	outcome, err := runTool(ctx, RunToolParams{
		ToolRef:              msg.Tool,
		Args:                 []string{msg.Input},
		CredentialSecretName: creds.SecretName,
		CredentialEnvVars:    creds.EnvVars,
	})
	switch {
	case err != nil:
		answer(false, "", err.Error())
	case outcome.Succeeded:
		answer(true, outcome.Result, "")
	default:
		answer(false, "", outcome.ErrorCode+": "+outcome.ErrorMessage)
	}
}
