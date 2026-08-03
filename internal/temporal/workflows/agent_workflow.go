package workflows

import (
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/catalog"
	"durable-agents/internal/continuation"
	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
)

// AgentWorkflow replaces agent-controller's AgentRun pod + bidirectional
// NATS channel: a sub-agent is a child workflow, and the up/down protocol
// (ready/progress/reply/failed ↔ prompt) becomes parent↔child signals.
// Human-in-the-loop is a durable signal wait — no pod idles on a human.
const (
	AgentWorkflowName = "AgentWorkflow"

	// AgentUpSignalPrefix + <child workflow id> is the channel a child sends
	// its up-messages on, delivered to the parent workflow.
	AgentUpSignalPrefix = "agent-up::"

	// AgentPromptSignal delivers the user's answer (or next instruction)
	// down to a running agent workflow.
	AgentPromptSignal = "agent-prompt"
)

const (
	// maxAgentDepth caps recursive delegation (conversation → agent →
	// agent…), closing agent-controller ADR 0001's open question.
	maxAgentDepth = 3

	defaultAgentMaxIterations = 8

	// agentEpisodeTimeout bounds a parent's wait on a child episode
	// (upstream's 1h AgentRun await, kept).
	agentEpisodeTimeout = time.Hour
)

// AgentUp is one child→parent message.
type AgentUp struct {
	Progress bool   `json:"progress,omitempty"` // narration only, keep waiting
	Final    bool   `json:"final,omitempty"`    // episode over; Message is the answer
	Failed   bool   `json:"failed,omitempty"`
	Message  string `json:"message"`
	Result   string `json:"result,omitempty"` // opaque agent continuation token
	Code     string `json:"code,omitempty"`
}

// AgentPrompt is one parent→child message (the HITL answer).
type AgentPrompt struct {
	Message string `json:"message"`
}

type AgentWorkflowInput struct {
	Agent            catalog.AgentDescriptor `json:"agent"`
	Goal             string                  `json:"goal"`
	Caller           activities.Caller       `json:"caller"`
	ParentWorkflowID string                  `json:"parentWorkflowId"`
	Depth            int                     `json:"depth"`

	// Credentials references the Secret the parent's authorization pre-flight
	// wrote for this run. The gate itself already ran in the parent — a child
	// never re-decides authorization, it only carries the reference to the
	// Jobs it launches.
	//
	// PodAgentWorkflow attaches it to its step Jobs, which is the per-user
	// token injection docs/pod-agents.md recorded as blocked. The declarative
	// AgentWorkflow has no pod of its own to inject into: for it, an Agent's
	// identityProviders act purely as a launch gate, and the tools it calls
	// carry their own (ADR 0032).
	Credentials credentials `json:"credentials,omitempty"`
}

// AgentWorkflow runs one agent episode. It reports everything to the parent
// via up-signals and completes after sending a final (or failed) one.
func AgentWorkflow(ctx workflow.Context, in AgentWorkflowInput) error {
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
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})

	// Assemble the agent's working set from its skillRefs: merged
	// role-visible tools + concatenated skill markdown under agentPrompt.
	prompt := in.Agent.AgentPrompt
	var tools []catalog.ToolDescriptor
	seenTools := map[string]bool{}
	for _, skillRef := range in.Agent.SkillRefs {
		var resolved *activities.SkillTools
		if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: skillRef,
		}).Get(ctx, &resolved); err != nil || resolved == nil {
			continue // fail closed per ref: an invisible skill contributes nothing
		}
		prompt += "\n\n" + resolved.Skill.Markdown
		for _, t := range resolved.Tools {
			if !seenTools[t.ID] {
				seenTools[t.ID] = true
				tools = append(tools, t)
			}
		}
	}

	// The agent's OWN declared tools (upstream ADR 0028). Additive to whatever
	// its skillRefs contributed, and resolved by id without a role filter:
	// skillRefs is prompt material the caller must be able to see, while
	// toolRefs is what the operator declared this agent may call.
	//
	// Cheaper here than upstream by construction. There it needs a
	// tool_call/tool_result NATS message pair, a callId-keyed pending map, an
	// SDK method, and a dispatch path duplicated from the parent's runTool —
	// because the sub-agent is a separate process. A child workflow simply
	// calls runTool, so "let an agent call a tool" is a lookup plus a merge.
	if len(in.Agent.ToolRefs) > 0 {
		var declared []catalog.ToolDescriptor
		if err := workflow.ExecuteActivity(actx, activities.ResolveAgentToolsActivityName, activities.ResolveAgentToolsInput{
			AgentID:  in.Agent.ID,
			ToolRefs: in.Agent.ToolRefs,
		}).Get(ctx, &declared); err != nil {
			// Not fatal: the agent keeps whatever its skills gave it, and the
			// planner simply has fewer options. Failing the episode over a
			// catalog read would be worse than a narrower toolset.
			logger.Warn("could not resolve the agent's declared toolRefs", "agentId", in.Agent.ID, "error", err)
		}
		for _, t := range declared {
			if !seenTools[t.ID] {
				seenTools[t.ID] = true
				tools = append(tools, t)
			}
		}
	}

	// Delegable agents for recursion, gated by depth.
	var delegable []catalog.AgentDescriptor
	if in.Depth < maxAgentDepth {
		if err := workflow.ExecuteActivity(actx, activities.RetrieveAgentsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Goal,
		}).Get(ctx, &delegable); err != nil {
			delegable = nil
		}
		// Never offer self-delegation.
		filtered := delegable[:0]
		for _, ag := range delegable {
			if ag.ID != in.Agent.ID {
				filtered = append(filtered, ag)
			}
		}
		delegable = filtered
	}

	goal := in.Goal
	toolContinuations := map[string]string{}
	var history []activities.ActionRecord
	prompts := workflow.GetSignalChannel(ctx, AgentPromptSignal)

	maxIterations := int(in.Agent.MaxIterations)
	if maxIterations <= 0 {
		maxIterations = defaultAgentMaxIterations
	}

	for iteration := 0; iteration < maxIterations; iteration++ {
		var plan activities.PlannedAgentAction
		if err := workflow.ExecuteActivity(actx, activities.PlanAgentActionActivityName, activities.PlanAgentActionInput{
			Goal:        goal,
			AgentPrompt: prompt,
			Tools:       tools,
			Agents:      delegable,
			History:     history,
		}).Get(ctx, &plan); err != nil {
			return fail("planner_error", err.Error())
		}

		switch plan.Action {
		case activities.AgentActionFinish:
			up(AgentUp{Final: true, Message: plan.Message})
			return nil

		case activities.AgentActionAskUser:
			// The whole point: a durable wait on a human, no pod running.
			up(AgentUp{Message: plan.Question})
			var answer AgentPrompt
			prompts.Receive(ctx, &answer)
			history = append(history, activities.ActionRecord{
				ToolID: "ask_user", Input: plan.Question, Succeeded: true, Result: answer.Message,
			})

		case activities.AgentActionCallTool:
			tool := findToolByID(plan.ToolID, tools)
			if tool == nil {
				history = append(history, activities.ActionRecord{
					ToolID: plan.ToolID, Input: plan.ToolInput,
					Error: "tool not available to this agent",
				})
				continue
			}

			// A container Tool that declares identityProviders must not run
			// credential-less here either (ADR 0032 §5). Upstream's sub-agent
			// dispatch path skips this check; a Tool meant to act as a specific
			// human would then run with whatever static token its template
			// carries, which is the gap that ADR closed on the parent's path.
			creds, refusal := toolCredentials(ctx, actx, TurnInput{Caller: in.Caller}, *tool)
			if refusal != "" {
				history = append(history, activities.ActionRecord{
					ToolID: plan.ToolID, Input: plan.ToolInput, Error: refusal,
				})
				continue
			}

			toolInput := plan.ToolInput
			if token := toolContinuations[plan.ToolID]; token != "" {
				toolInput = continuation.Prepend(token, toolInput)
			}
			up(AgentUp{Progress: true, Message: "Running " + plan.ToolID + "…"})
			outcome, err := runTool(ctx, RunToolParams{
				ToolRef:              plan.ToolID,
				Args:                 []string{toolInput},
				CredentialSecretName: creds.SecretName,
				CredentialEnvVars:    creds.EnvVars,
				OnProgress: func(e messaging.Event) {
					line := e.Message
					if e.Stage != "" {
						line = e.Stage + ": " + line
					}
					up(AgentUp{Progress: true, Message: line})
				},
			})
			if err != nil {
				return fail("tool_launch_error", err.Error())
			}
			record := activities.ActionRecord{ToolID: plan.ToolID, Input: plan.ToolInput, Succeeded: outcome.Succeeded}
			if outcome.Succeeded {
				token, stripped := continuation.Extract(outcome.Result)
				if token != "" {
					toolContinuations[plan.ToolID] = token
				}
				record.Result = stripped
			} else {
				record.Error = outcome.ErrorCode + ": " + outcome.ErrorMessage
			}
			history = append(history, record)

		case activities.AgentActionDelegate:
			sub := findAgent(plan.AgentID, delegable)
			if sub == nil {
				history = append(history, activities.ActionRecord{
					ToolID: "delegate:" + plan.AgentID, Input: plan.Goal,
					Error: "agent not delegable (unknown, invisible, or depth cap)",
				})
				continue
			}
			up(AgentUp{Progress: true, Message: "Delegating to " + sub.ID + "…"})
			result, err := superviseChildAgent(ctx, *sub, plan.Goal, in.Caller, in.Depth+1,
				func(line string) { up(AgentUp{Progress: true, Message: line}) },
				func(question string) string {
					// Bubble the sub-agent's question all the way to the
					// human, then relay the answer back down.
					up(AgentUp{Message: question})
					var answer AgentPrompt
					prompts.Receive(ctx, &answer)
					return answer.Message
				},
			)
			record := activities.ActionRecord{ToolID: "delegate:" + sub.ID, Input: plan.Goal}
			if err != nil {
				record.Error = err.Error()
			} else {
				record.Succeeded = true
				record.Result = result
			}
			history = append(history, record)
		}
	}

	up(AgentUp{Final: true, Message: bestEffortSummary(history)})
	return nil
}

// superviseChildAgent starts a child AgentWorkflow and pumps its up-signals:
// progress → onProgress, question → onQuestion (returns the answer to relay
// down), final/failed → return. Used by AgentWorkflow for recursion; the
// conversation workflow has its own non-blocking variant.
func superviseChildAgent(
	ctx workflow.Context,
	agent catalog.AgentDescriptor,
	goal string,
	caller activities.Caller,
	depth int,
	onProgress func(string),
	onQuestion func(string) string,
) (string, error) {
	childID, err := newChildAgentID(ctx, agent.ID)
	if err != nil {
		return "", err
	}
	cctx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID: childID,
	})
	child := workflow.ExecuteChildWorkflow(cctx, agentWorkflowNameFor(agent), AgentWorkflowInput{
		Agent:            agent,
		Goal:             goal,
		Caller:           caller,
		ParentWorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		Depth:            depth,
	})
	if err := child.GetChildWorkflowExecution().Get(ctx, nil); err != nil {
		return "", fmt.Errorf("start child agent %s: %w", agent.ID, err)
	}

	upCh := workflow.GetSignalChannel(ctx, AgentUpSignalPrefix+childID)
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()
	timer := workflow.NewTimer(timerCtx, agentEpisodeTimeout)

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
			return "", fmt.Errorf("agent %s timed out after %s", agent.ID, agentEpisodeTimeout)
		}
		if !received {
			continue
		}
		switch {
		case u.Failed:
			return "", fmt.Errorf("agent %s failed (%s): %s", agent.ID, u.Code, u.Message)
		case u.Final:
			return u.Message, nil
		case u.Progress:
			if onProgress != nil {
				onProgress(u.Message)
			}
		default: // question
			answer := onQuestion(u.Message)
			if err := workflow.SignalExternalWorkflow(ctx, childID, "", AgentPromptSignal, AgentPrompt{Message: answer}).Get(ctx, nil); err != nil {
				return "", fmt.Errorf("relay answer to agent %s: %w", agent.ID, err)
			}
		}
	}
}

// agentWorkflowNameFor routes by execution style. All three speak the same
// parent-facing up/down signal protocol, so a conversation cannot tell them
// apart:
//
//   - step-tool annotation → checkpoint-resume Jobs (docs/pod-agents.md)
//   - bridged annotation   → an unmodified upstream AgentRun over NATS
//   - neither              → the declarative agent loop
//
// StepToolRef wins a conflict: it is a concrete statement about how the image
// behaves, where Bridged only says which transport to use.
func agentWorkflowNameFor(agent catalog.AgentDescriptor) string {
	switch {
	case agent.StepToolRef != "":
		return PodAgentWorkflowName
	case agent.Bridged:
		return BridgedAgentWorkflowName
	default:
		return AgentWorkflowName
	}
}

func newChildAgentID(ctx workflow.Context, agentID string) (string, error) {
	var id string
	err := workflow.SideEffect(ctx, func(workflow.Context) any {
		return "agent-" + agentID + "-" + uuid.NewString()
	}).Get(&id)
	return id, err
}

// findToolByID resolves the planner's chosen id against the agent's own
// working set. Nil means the planner named something it was not offered.
func findToolByID(toolID string, tools []catalog.ToolDescriptor) *catalog.ToolDescriptor {
	for i := range tools {
		if tools[i].ID == toolID {
			return &tools[i]
		}
	}
	return nil
}

func findAgent(id string, agents []catalog.AgentDescriptor) *catalog.AgentDescriptor {
	for i := range agents {
		if agents[i].ID == id {
			return &agents[i]
		}
	}
	return nil
}

func bestEffortSummary(history []activities.ActionRecord) string {
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Succeeded && history[i].Result != "" {
			return "I ran out of steps; the last useful result was:\n\n" + history[i].Result
		}
	}
	return "I couldn't complete the goal within my step budget."
}
