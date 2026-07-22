package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/catalog"
	"durable-agents/internal/continuation"
)

// delegateToAgent starts a fresh agent episode as a child workflow and
// relays its first non-progress up-signal into the turn: a question becomes
// the reply with the episode left active for the next turn; a final message
// closes the episode and banks the agent's continuation token.
func delegateToAgent(ctx workflow.Context, state *ConversationState, in TurnInput, agent catalog.AgentDescriptor, meta *TurnMeta, note func(string)) (string, TurnMeta, error) {
	meta.Path = "agent"
	meta.AgentID = agent.ID
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
	child := workflow.ExecuteChildWorkflow(cctx, AgentWorkflowName, AgentWorkflowInput{
		Agent:            agent,
		Goal:             goal,
		Caller:           in.Caller,
		ParentWorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		Depth:            1,
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