package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/authz"
	"durable-agents/internal/catalog"
	"durable-agents/internal/continuation"
)

// delegateToAgent starts a fresh agent episode as a child workflow and
// relays its first non-progress up-signal into the turn: a question becomes
// the reply with the episode left active for the next turn; a final message
// closes the episode and banks the agent's continuation token.
func delegateToAgent(ctx workflow.Context, actx workflow.Context, state *ConversationState, in TurnInput, agent catalog.AgentDescriptor, meta *TurnMeta, note func(string)) (string, TurnMeta, error) {
	meta.Path = "agent"
	meta.AgentID = agent.ID

	// Authorization pre-flight, before anything is launched (upstream ADR
	// 0030). Plain control flow: no model call reaches this decision, and
	// nothing downstream can skip it.
	verdict, err := authorizeAgent(ctx, actx, in, agent)
	if err != nil {
		return "", *meta, fmt.Errorf("authorize %s: %w", agent.ID, err)
	}
	switch verdict.Kind {
	case authz.KindAuthorized:
		// Adopt the principal the credentials were actually keyed by. The
		// pre-flight may have UPGRADED it this turn; without adopting it,
		// anything that later re-derives the key would invalidate a record
		// that was never written and leave the caller re-reading a dead
		// credential forever.
		if verdict.Principal != "" {
			in.Caller.Principal = verdict.Principal
		}
		state.PendingIdentityLink = nil
	case authz.KindLinkRequired:
		meta.Path = "link-required"
		note("Waiting for an account link")
		if verdict.Pending != nil {
			anchor := *verdict.Pending
			// Capture the goal, not the message that eventually notices the
			// link landed. Without this the resume re-delegates "ok, linked
			// it" and the user's actual request is lost.
			anchor.Request = in.Message
			state.PendingIdentityLink = &anchor
		}
		return verdict.Message, *meta, nil
	default:
		meta.Path = "misconfigured"
		state.PendingIdentityLink = nil
		return "I can't run that agent right now: " + verdict.Error, *meta, nil
	}

	note("Delegating to agent " + agent.ID + "…")

	goal := in.Message
	if token := state.AgentContinuations[agent.ID]; token != "" {
		goal = continuation.Prepend(token, goal)
	}

	childID, err := newChildAgentID(ctx, agent.ID)
	if err != nil {
		return "", *meta, err
	}
	cctx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{WorkflowID: childID})
	child := workflow.ExecuteChildWorkflow(cctx, agentWorkflowNameFor(agent), AgentWorkflowInput{
		Agent:            agent,
		Goal:             goal,
		Caller:           in.Caller,
		ParentWorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		Depth:            1,
		// A reference, not credentials: the child attaches it to the Jobs it
		// launches, and the kubelet is the only thing that reads a value.
		Credentials: credentials{SecretName: verdict.SecretName, EnvVars: verdict.EnvVarNames},
	})
	// Wait for the start (not completion): the update handler returns while
	// the child keeps running under this conversation. ParentClosePolicy
	// (default TERMINATE) reaps abandoned episodes when the conversation
	// completes.
	if err := child.GetChildWorkflowExecution().Get(ctx, nil); err != nil {
		return "", *meta, fmt.Errorf("start agent %s: %w", agent.ID, err)
	}
	state.ActiveAgentID = agent.ID
	state.ActiveAgentWorkflowID = childID

	return handleAgentUp(ctx, state, agent.ID, childID, note), *meta, nil
}

// handleAgentUp pumps the active child's up-signals until something ends
// the turn: progress lines feed the narration; a question ends the turn
// with the episode still active; final/failed/timeout close the episode.
func handleAgentUp(ctx workflow.Context, state *ConversationState, agentID, childID string, note func(string)) string {
	upCh := workflow.GetSignalChannel(ctx, AgentUpSignalPrefix+childID)
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()
	timer := workflow.NewTimer(timerCtx, agentEpisodeTimeout)

	clearActive := func() {
		state.ActiveAgentID, state.ActiveAgentWorkflowID = "", ""
	}

	for {
		var (
			u        AgentUp
			received bool
			timedOut bool
		)
		selector := workflow.NewSelector(ctx)
		selector.AddReceive(upCh, func(c workflow.ReceiveChannel, _ bool) {
			c.Receive(ctx, &u)
			received = true
		})
		selector.AddFuture(timer, func(workflow.Future) { timedOut = true })
		selector.Select(ctx)

		if timedOut {
			clearActive()
			_ = workflow.RequestCancelExternalWorkflow(ctx, childID, "").Get(ctx, nil)
			return fmt.Sprintf("Agent %s didn't respond within %s; I've cancelled it.", agentID, agentEpisodeTimeout)
		}
		if !received {
			continue
		}
		switch {
		case u.Progress:
			note(u.Message)
		case u.Failed:
			clearActive()
			return fmt.Sprintf("Agent %s failed (%s): %s", agentID, u.Code, u.Message)
		case u.Final:
			clearActive()
			if u.Result != "" {
				if state.AgentContinuations == nil {
					state.AgentContinuations = map[string]string{}
				}
				state.AgentContinuations[agentID] = u.Result
			}
			return u.Message
		default: // a question — the episode stays active across turns
			note("Agent " + agentID + " needs input")
			return u.Message
		}
	}
}
