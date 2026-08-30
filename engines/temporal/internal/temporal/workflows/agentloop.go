package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/continuation"
	"github.com/controller-agent/temporal-engine/internal/llm"
	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// maxToolSteps bounds the plan⇄runTool loop per turn (upstream MAX_TOOL_STEPS).
const maxToolSteps = 4

// TurnMeta reports what the agent loop did, for TurnResult/debugging.
type TurnMeta struct {
	// Path is how this turn reached its target:
	//   bare             — no capability needed (ADR 0019), or no identity
	//   tool             — a bare tool won the combined delegate selection (ADR 0037)
	//   fallback-tool    — no skill or agent matched; one catalog tool did
	//   fallback-bare    — no skill, agent, or tool matched
	//   skill            — selected by retrieval
	//   skill-continued  — the conversation's active skill still fits
	//   skill-routed     — named by an IntegrationRoute (ADR 0024)
	//   agent            — selected by retrieval
	//   agent-continued  — an episode already in flight took the turn
	//   agent-routed     — named by an IntegrationRoute (ADR 0024)
	Path      string   `json:"path"`
	SkillID   string   `json:"skillId,omitempty"` // active skill after this turn
	AgentID   string   `json:"agentId,omitempty"` // agent handling this turn
	ToolCalls []string `json:"toolCalls,omitempty"`
	// Narration is the turn's full progress transcript — the authoritative
	// version of what TurnProgressQuery exposed while the turn ran.
	Narration []string `json:"narration,omitempty"`
	// RemoteControlUrl is the delegated agent's live Remote Control session
	// URL (https://claude.ai/code/session_...), when the turn's episode
	// reported one (see TurnProgress.RemoteControlUrl / ConversationState.
	// RemoteControlUrl). Empty for every run that never emits one.
	RemoteControlUrl string `json:"remoteControlUrl,omitempty"`
}

// runAgentTurn is the ported agent loop: active agent → integration route →
// active-skill fit check → capability gate → retrieve → select → resolve
// tools → plan⇄runTool → compose. It returns the reply plus which skill (if
// any) stays active. Mirrors agent-controller's graph nodes.
func runAgentTurn(ctx workflow.Context, actx workflow.Context, state *ConversationState, in TurnInput, note func(string)) (string, TurnMeta, []callertools.PendingCall, error) {
	logger := workflow.GetLogger(ctx)
	meta := TurnMeta{Path: "bare"}
	if note == nil {
		note = func(string) {}
	}

	// 0. Mid-episode agent takes the turn outright (upstream's
	// checkActiveAgentRun): forward the message as the HITL answer.
	if state.ActiveAgentWorkflowID != "" {
		note("Continuing with agent " + state.ActiveAgentID)
		err := workflow.SignalExternalWorkflow(ctx, state.ActiveAgentWorkflowID, "", AgentPromptSignal, AgentPrompt{Message: in.Message}).Get(ctx, nil)
		if err == nil {
			meta.Path = "agent-continued"
			meta.AgentID = state.ActiveAgentID
			gen := state.beginAgentListen(ctx)
			reply, preempted := handleAgentUp(ctx, state, state.ActiveAgentID, state.ActiveAgentWorkflowID, gen, note)
			if preempted {
				// A still-later turn took over listening for this episode's
				// reply before (or while) this one was waiting — that turn
				// owns finishing this exchange; this one must not answer on
				// its behalf or touch ActiveAgentWorkflowID (see
				// AgentListenGeneration's doc comment).
				reply = "A newer message is already being processed for this conversation."
			}
			return reply, meta, nil, nil
		}
		// Child gone (terminated or already closed) — clear and fall through.
		logger.Warn("active agent unreachable; falling back", "workflowId", state.ActiveAgentWorkflowID, "error", err)
		state.ActiveAgentID, state.ActiveAgentWorkflowID = "", ""
	}

	var skillTools *activities.SkillTools

	// 0.5. Deterministic dispatch (ADR 0024). The gateway matched this turn's
	// event descriptor to an IntegrationRoute and named a target; re-resolve
	// it under the caller's CURRENT roles and go straight there, skipping
	// retrieval. Deliberately AFTER the active-agent check above: a re-applied
	// trigger label on an issue an agent is already working would otherwise
	// start the work a second time — a second branch and a second PR on a real
	// coding agent. A miss falls through, never an error.
	if in.Caller.Subject != "" {
		if in.ForcedAgentID != "" {
			var agent *catalog.AgentDescriptor
			if err := workflow.ExecuteActivity(actx, activities.ResolveAgentActivityName, activities.ResolveAgentInput{
				Caller:  in.Caller,
				AgentID: in.ForcedAgentID,
			}).Get(ctx, &agent); err != nil {
				logger.Warn("forced agent lookup failed; falling through to retrieval", "agentId", in.ForcedAgentID, "error", err)
			} else if agent != nil {
				note("Routing to agent " + agent.ID)
				reply, m, err := delegateToAgent(ctx, actx, state, in, *agent, &meta, note, nil)
				if m.Path == "agent" {
					m.Path = "agent-routed"
				}
				return reply, m, nil, err
			} else {
				logger.Info("forced agent not visible to caller; falling through", "agentId", in.ForcedAgentID)
			}
		}
		if in.ForcedSkillID != "" {
			var resolved *activities.SkillTools
			if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
				Caller:  in.Caller,
				SkillID: in.ForcedSkillID,
			}).Get(ctx, &resolved); err != nil {
				logger.Warn("forced skill lookup failed; falling through to retrieval", "skillId", in.ForcedSkillID, "error", err)
			} else if resolved != nil {
				skillTools = resolved
				meta.Path = "skill-routed"
				note("Routing to skill " + resolved.Skill.ID)
			} else {
				logger.Info("forced skill not visible to caller; falling through", "skillId", in.ForcedSkillID)
			}
		}
	}

	// 0.6. A turn that stopped for an account link resumes here, with the
	// ORIGINAL goal (upstream's checkPendingIdentityLink). Re-running the
	// pre-flight is the only thing that decides whether the link landed —
	// never the user saying it did.
	if skillTools == nil && state.PendingIdentityLink != nil && in.Caller.Subject != "" {
		if reply, m, handled, err := resumePendingLink(ctx, actx, state, in, &meta, note); handled {
			return reply, m, nil, err
		}
	}

	// 1. Session continuity (ADR 0012): re-fetch the active skill under the
	// caller's CURRENT roles (fail closed), then a cheap fit check. Any miss
	// falls through to the full path — never an error.
	if skillTools == nil && state.ActiveSkillID != "" && in.Caller.Subject != "" {
		var resolved *activities.SkillTools
		err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: state.ActiveSkillID,
		}).Get(ctx, &resolved)
		if err == nil && resolved != nil {
			var fits bool
			if err := workflow.ExecuteActivity(actx, activities.CheckSkillFitActivityName, activities.CheckSkillFitInput{
				Request: in.Message,
				Skill:   resolved.Skill,
			}).Get(ctx, &fits); err == nil && fits {
				// "Yes, still the same task" can still be the wrong answer if
				// this turn names a capability the active skill's own tools
				// could never satisfy — see hasOutOfScopeToolMatch.
				if hasOutOfScopeToolMatch(ctx, actx, in, resolved) {
					logger.Info("active skill fits but the turn names an out-of-scope tool; re-retrieving",
						"skillId", resolved.Skill.ID)
				} else {
					skillTools = resolved
					meta.Path = "skill-continued"
					note("Continuing with skill " + resolved.Skill.ID)
				}
			}
		}
		if skillTools == nil {
			state.ActiveSkillID = "" // stale or unfit — full re-selection
		}
	}

	if skillTools == nil {
		// 2. Capability gate (ADR 0019): purely conversational turns skip
		// the catalog entirely. Gate errors default to the capability path.
		needsCapability := true
		if err := workflow.ExecuteActivity(actx, activities.CheckNeedsCapabilityActivityName, in.Message).Get(ctx, &needsCapability); err != nil {
			logger.Warn("capability gate failed; assuming capabilities needed", "error", err)
			needsCapability = true
		}
		if !needsCapability || in.Caller.Subject == "" {
			reply, err := bareAnswer(ctx, actx, in.Message)
			return reply, meta, nil, err
		}

		// 3. Retrieval (RBAC-filtered), skills and agents in parallel-ish.
		note("Selecting a skill…")
		var skills []catalog.SkillDescriptor
		if err := workflow.ExecuteActivity(actx, activities.RetrieveSkillsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Message,
		}).Get(ctx, &skills); err != nil {
			logger.Warn("skill retrieval failed; answering bare", "error", err)
		}
		var agents []catalog.AgentDescriptor
		if err := workflow.ExecuteActivity(actx, activities.RetrieveAgentsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Message,
		}).Get(ctx, &agents); err != nil {
			logger.Warn("agent retrieval failed", "error", err)
		}

		// Bare tools compete DIRECTLY in the selection below (ADR 0037), not
		// only once skills and agents both come up empty. Retrieve and
		// relevance-gate the catalog with the same CheckToolFit two-stage gate
		// selectFallbackTool already uses, so a well-fitting Tool is offered to
		// the combined selector rather than being starved out by a broad Agent
		// that merely overlaps the request. Mirrors the langgraph engine's
		// retrieveTools node.
		fittedTools := fitCandidates(ctx, actx, in.Message, retrieveCatalogTools(ctx, actx, in))

		if len(skills) == 0 && len(agents) == 0 && len(fittedTools) == 0 {
			reply, m, pending, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, pending, err
		}

		// 4. Selection: one combined skill/agent/tool choice when agents or
		// tools are on the table; plain skill selection when only skills
		// matched (nothing to weigh a skill against).
		var skillID string
		if len(agents) > 0 || len(fittedTools) > 0 {
			var choice activities.DelegateChoice
			if err := workflow.ExecuteActivity(actx, activities.SelectDelegateActivityName, activities.SelectDelegateInput{
				Request: in.Message,
				Skills:  skills,
				Agents:  agents,
				Tools:   fittedTools,
			}).Get(ctx, &choice); err != nil {
				logger.Warn("delegate selection failed; answering bare", "error", err)
			}
			switch choice.Kind {
			case activities.DelegateAgent:
				if agent := findAgent(choice.ID, agents); agent != nil {
					reply, m, err := delegateToAgent(ctx, actx, state, in, *agent, &meta, note, nil)
					return reply, m, nil, err
				}
			case activities.DelegateTool:
				if tool := findToolDescriptor(choice.ID, fittedTools); tool != nil {
					// Plan the concrete call, then run it as a first-class
					// selection — never the noMatchFallback footer path. A
					// planner that declines, or a decline that leaves no call,
					// falls through to noMatchFallback's own safety net below.
					// No caller tools offered here: the delegate selector already
					// picked THIS one catalog tool specifically, and a caller
					// tool is never among its candidates (SelectDelegateInput
					// carries no CallerTools).
					if planned, toolInput, ok, _ := planToolCall(ctx, actx, in, []catalog.ToolDescriptor{*tool}, nil, false); ok {
						reply, m, err := runSelectedTool(ctx, actx, state, in, planned, toolInput, &meta, note)
						return reply, m, nil, err
					}
				}
			case activities.DelegateSkill:
				skillID = choice.ID
			}
		} else {
			if err := workflow.ExecuteActivity(actx, activities.SelectSkillActivityName, activities.SelectSkillInput{
				Request:    in.Message,
				Candidates: skills,
			}).Get(ctx, &skillID); err != nil {
				skillID = ""
			}
		}
		if skillID == "" {
			reply, m, pending, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, pending, err
		}

		// 5. Resolve the skill's declared tools directly (no re-ranking),
		// RBAC re-checked (ADR 0008).
		if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: skillID,
		}).Get(ctx, &skillTools); err != nil || skillTools == nil {
			reply, m, pending, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, pending, err
		}
		meta.Path = "skill"
		note("Using skill " + skillTools.Skill.ID)
	}

	state.ActiveSkillID = skillTools.Skill.ID
	meta.SkillID = skillTools.Skill.ID

	// Caller-supplied tools are APPENDED to whatever the skill declared, so an
	// authored procedure can use one (a skill that writes a document calling
	// the client's own save_file). A skill may refuse them — nil means allowed
	// (ADR 0035 §4). The gate keeps an authored skill's loop predictable; it is
	// not an authorization boundary, and is not treated as one.
	callerTools := in.CallerTools
	if skillTools.Skill.AllowCallerTools != nil && !*skillTools.Skill.AllowCallerTools {
		callerTools = nil
	}

	// A skill's own agentRefs (ADR 0021) reach the planner as candidates too,
	// adapted into the same ToolDescriptor shape an agent-backed Tool
	// (Tool.spec.agentRef) already produces (upstream's loadSkillTools,
	// graph.ts:1703-1758) — the planner and the dispatch below don't need to
	// know whether AgentRef came from a Tool wrapper or a Skill's own refs.
	planCandidates := skillTools.Tools
	for _, agent := range skillTools.Agents {
		planCandidates = append(planCandidates, adaptAgentAsTool(agent))
	}

	// 6. plan ⇄ runTool loop.
	//
	// History is SEEDED from calls the client already executed (ADR 0035 §1).
	// That is both how a resumed turn sees its own prior results and how the
	// resumed loop stays bounded: maxToolSteps counts history length, so a
	// client cannot drive an unbounded planner loop by resending.
	history := seedHistory(in.PriorCallerToolCalls)
	var lastSuccess *ToolOutcome
	for step := len(history); step < maxToolSteps; step++ {
		var plan activities.PlannedAction
		if err := workflow.ExecuteActivity(actx, activities.PlanActionActivityName, activities.PlanActionInput{
			Request:            in.Message,
			SkillMarkdown:      skillTools.Skill.Markdown,
			Tools:              planCandidates,
			History:            history,
			CallerTools:        callerTools,
			CallerToolRequired: in.CallerToolRequired,
		}).Get(ctx, &plan); err != nil {
			return "", meta, nil, fmt.Errorf("action planner: %w", err)
		}

		if plan.Action == activities.ActionRespond {
			return plan.Response, meta, nil, nil
		}
		if plan.Action == activities.ActionFinish {
			break
		}

		// Guard a stuck loop re-issuing an identical call, BEFORE either
		// dispatch branch: this is about the planner repeating itself, which is
		// independent of whose tool it chose. Ordering matters — a caller tool
		// checked after its own branch would be re-offered to the client
		// forever on a resumed turn.
		if repeatsLastCall(history, plan) {
			logger.Warn("planner repeated identical call; finishing", "toolId", plan.ToolID)
			// Carry the last result through, the same way the explicit finish
			// branches do. On a RESUMED caller-tool turn no tool ran in this
			// invocation, so the answer lives only in the seeded history — and
			// tool_choice "required", re-applied on the resend, is exactly what
			// pushes the planner to re-issue the byte-identical call that lands
			// here. Without this the facade renders an empty result.
			if lastSuccess == nil {
				if seeded := lastHistoryResult(history); seeded != "" {
					return seeded, meta, nil, nil
				}
			}
			break
		}

		// The one branch that executes nothing: a caller tool ends the turn by
		// asking the client to run it (ADR 0035 §1).
		if callertools.IsID(plan.ToolID) {
			call, ok, err := pendingCallerCall(ctx, callerTools, plan)
			if err != nil {
				return "", meta, nil, err
			}
			if ok {
				meta.ToolCalls = append(meta.ToolCalls, plan.ToolID)
				note("Asking your client to run " + callertools.NameFromID(plan.ToolID))
				return "", meta, []callertools.PendingCall{call}, nil
			}
			logger.Warn("planner chose an unoffered caller tool", "toolId", plan.ToolID)
			history = append(history, activities.ActionRecord{
				ToolID: plan.ToolID, Input: plan.ToolInput,
				Error: "tool not available to this skill/caller",
			})
			continue
		}

		// Re-validate the planner's tool choice against the skill's
		// resolved, role-visible tools — never trusted blindly (ADR 0008).
		if !toolInScope(plan.ToolID, skillTools) {
			logger.Warn("planner chose out-of-scope tool", "toolId", plan.ToolID)
			history = append(history, activities.ActionRecord{
				ToolID: plan.ToolID, Input: plan.ToolInput,
				Error: "tool not available to this skill/caller",
			})
			continue
		}

		tool := *findTool(plan.ToolID, skillTools)

		// Identity gate — shared by a container Tool and an agent-backed one
		// (upstream's resolveToolIdentitySecretEnv, ADR 0032 §5/0022): read-only
		// resolution of an already-linked credential, never starting a fresh
		// link flow.
		creds, refusal := toolCredentials(ctx, actx, in, tool)
		if refusal != "" {
			note(plan.ToolID + " needs a linked account")
			return refusal, meta, nil, nil
		}

		note("Running " + plan.ToolID + "…")
		outcome, err := runToolWithContinuation(ctx, actx, state, in, tool, plan.ToolInput, plan.ToolInstanceKey, creds, note)
		if err != nil {
			return "", meta, nil, err
		}
		meta.ToolCalls = append(meta.ToolCalls, plan.ToolID)
		record := activities.ActionRecord{ToolID: plan.ToolID, Input: plan.ToolInput, Succeeded: outcome.Succeeded}
		if outcome.Succeeded {
			record.Result = outcome.Result
			lastSuccess = &outcome
			note(plan.ToolID + " finished")
		} else {
			record.Error = outcome.ErrorCode + ": " + outcome.ErrorMessage
			note(plan.ToolID + " failed: " + outcome.ErrorCode)
		}
		history = append(history, record)
	}

	// 7. Compose (ADR 0015): additive prefix/suffix around the verbatim
	// result of the last successful tool call.
	if lastSuccess != nil {
		note("Composing reply…")
		var framed activities.ComposedResponse
		if err := workflow.ExecuteActivity(actx, activities.ComposeResponseActivityName, activities.ComposeResponseInput{
			Request:       in.Message,
			SkillMarkdown: skillTools.Skill.Markdown,
			Result:        lastSuccess.Result,
		}).Get(ctx, &framed); err != nil {
			logger.Warn("compose failed; returning bare result", "error", err)
		}
		return framed.Prefix + lastSuccess.Result + framed.Suffix, meta, nil, nil
	}
	if len(history) > 0 {
		last := history[len(history)-1]
		return fmt.Sprintf("I couldn't complete that: %s failed (%s).", last.ToolID, last.Error), meta, nil, nil
	}
	reply, m, err := bareAnswerWithMeta(ctx, actx, in.Message, meta)
	return reply, m, nil, err
}

// runToolWithContinuation is one tool call with ADR 0017's resume token
// handling folded in: the tool's own stored token is prepended to its input,
// and any token the tool returns is banked and stripped off the result.
//
// The continuation key is scoped to the planner's declared instanceKey
// (`${tool.id}::${instanceKey}`, upstream's runTool) so two instances of the
// same multi-instance tool in one conversation don't clobber each other's
// saved state; an empty instanceKey is the bare tool id, unchanged from
// before this scoping existed.
//
// Stripping happens BEFORE the result reaches planner history, composition,
// or the reply, so resume state never enters the transcript or a prompt. Both
// the skill loop and the no-match fallback go through here, because a tool
// does not change its contract based on how it was selected.
//
// Dispatch branches on tool.AgentRef (ADR 0021/agentRunTemplate): an
// agent-backed tool runs as an AgentRun over the same child-workflow bridge
// peer-level delegation uses, instead of a ToolRun Job (upstream's runTool,
// graph.ts:1845-1910).
func runToolWithContinuation(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	tool catalog.ToolDescriptor,
	toolInput, instanceKey string,
	creds credentials,
	note func(string),
) (ToolOutcome, error) {
	continuationKey := tool.ID
	if instanceKey != "" {
		continuationKey = tool.ID + "::" + instanceKey
	}
	if token := state.ToolContinuations[continuationKey]; token != "" {
		toolInput = continuation.Prepend(token, toolInput)
	}

	var outcome ToolOutcome
	var err error
	switch {
	case tool.LocalExec != nil:
		outcome, err = runLocalTool(ctx, tool, toolInput)
	case tool.AgentRef != "":
		outcome, err = runAgentBackedTool(ctx, actx, in, tool, toolInput, creds, note)
	default:
		outcome, err = runTool(ctx, RunToolParams{
			ToolRef:              tool.ID,
			Args:                 []string{toolInput},
			CredentialSecretName: creds.SecretName,
			CredentialEnvVars:    creds.EnvVars,
			OnProgress: func(e messaging.Event) {
				line := e.Message
				if e.Stage != "" {
					line = e.Stage + ": " + line
				}
				note(line)
			},
		})
	}
	if err != nil || !outcome.Succeeded {
		return outcome, err
	}

	token, stripped := continuation.Extract(outcome.Result)
	if token != "" {
		if state.ToolContinuations == nil {
			state.ToolContinuations = map[string]string{}
		}
		state.ToolContinuations[continuationKey] = token
	}
	outcome.Result = stripped
	return outcome, nil
}

// runAgentBackedTool dispatches an agent-backed Tool (ToolDescriptor.AgentRef,
// whether from a Tool CR's own spec.agentRef or adapted from a Skill's
// agentRefs — see adaptAgentAsTool) as a single-turn AgentRun over the same
// child-workflow bridge peer-level delegation (delegateToAgent) uses.
//
// v1 scope cut, matching upstream: single-turn/final-reply only. There is no
// session slot to resume a specific tool-launched episode the way
// checkActiveAgentRun does for peer-level delegation, so a clarifying
// (non-final) reply is a clean tool error rather than silently dropped.
// localToolBackstopBufferSeconds mirrors the TS client's default: extra time
// beyond the tool's own timeout before giving up on an unresponsive sidecar
// (the sidecar's own SIGKILL + envelope should normally win the race).
const localToolBackstopBufferSeconds = 5

// runLocalTool dispatches a LocalTool (ADR 0014) to its executor sidecar via
// RunLocalToolActivity — never a k8s Job. The activity call is given its own
// timeout scoped to the tool's own declared timeoutSeconds (falling back to
// the sidecar's own default when unset) plus a backstop buffer, since a
// LocalTool run blocks synchronously for the activity's whole duration,
// unlike a Job's launch-then-await-callback shape.
func runLocalTool(ctx workflow.Context, tool catalog.ToolDescriptor, toolInput string) (ToolOutcome, error) {
	timeoutSeconds := tool.LocalExec.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = defaultToolTimeoutSeconds
	}
	lactx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: time.Duration(timeoutSeconds)*time.Second + localToolBackstopBufferSeconds*time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1}, // never re-execute a tool that already ran
	})

	var event messaging.Event
	if err := workflow.ExecuteActivity(lactx, activities.RunLocalToolActivityName, activities.RunLocalToolInput{
		Tool:      tool,
		Input:     toolInput,
		SessionID: workflow.GetInfo(ctx).WorkflowExecution.ID,
	}).Get(ctx, &event); err != nil {
		return ToolOutcome{}, fmt.Errorf("run local tool %s: %w", tool.ID, err)
	}

	outcome := ToolOutcome{JobID: event.JobID}
	if event.Type == messaging.EventSucceeded {
		outcome.Succeeded = true
		outcome.Result = event.ResultText()
		outcome.RawResult = event.Result
	} else {
		outcome.ErrorCode = event.Code
		outcome.ErrorMessage = event.Message
	}
	return outcome, nil
}

func runAgentBackedTool(
	ctx workflow.Context,
	actx workflow.Context,
	in TurnInput,
	tool catalog.ToolDescriptor,
	toolInput string,
	creds credentials,
	note func(string),
) (ToolOutcome, error) {
	var agent *catalog.AgentDescriptor
	if err := workflow.ExecuteActivity(actx, activities.ResolveAgentActivityName, activities.ResolveAgentInput{
		Caller:  in.Caller,
		AgentID: tool.AgentRef,
	}).Get(ctx, &agent); err != nil {
		return ToolOutcome{}, fmt.Errorf("resolve agent-backed tool %s: %w", tool.ID, err)
	}
	if agent == nil {
		return ToolOutcome{
			ErrorCode:    "agent_unavailable",
			ErrorMessage: fmt.Sprintf("tool %s's backing agent %s is not visible to this caller", tool.ID, tool.AgentRef),
		}, nil
	}

	childID, err := newChildAgentID(ctx, agent.ID)
	if err != nil {
		return ToolOutcome{}, err
	}
	cctx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{WorkflowID: childID})
	child := workflow.ExecuteChildWorkflow(cctx, agentWorkflowNameFor(*agent), AgentWorkflowInput{
		Agent:            *agent,
		Goal:             toolInput,
		Caller:           in.Caller,
		ParentWorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		Depth:            1,
		Credentials:      credentials{SecretName: creds.SecretName, EnvVars: creds.EnvVars},
	})
	if err := child.GetChildWorkflowExecution().Get(ctx, nil); err != nil {
		return ToolOutcome{}, fmt.Errorf("start agent-backed tool %s: %w", tool.ID, err)
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
			_ = workflow.RequestCancelExternalWorkflow(ctx, childID, "").Get(ctx, nil)
			return ToolOutcome{
				ErrorCode:    "timeout",
				ErrorMessage: fmt.Sprintf("agent-backed tool %s didn't respond within %s", tool.ID, agentEpisodeTimeout),
			}, nil
		}
		if !received {
			continue
		}
		switch {
		case u.Progress:
			note(u.Message)
		case u.Failed:
			return ToolOutcome{ErrorCode: u.Code, ErrorMessage: u.Message}, nil
		case u.Final:
			return ToolOutcome{Succeeded: true, Result: u.Message}, nil
		default:
			// A clarifying question: no session slot exists to resume this
			// specific tool-launched episode, so it ends the call as an error
			// rather than half-handling it (upstream's identical v1 scope cut).
			_ = workflow.RequestCancelExternalWorkflow(ctx, childID, "").Get(ctx, nil)
			return ToolOutcome{
				ErrorCode:    "non_final_reply",
				ErrorMessage: fmt.Sprintf("tool %s (agent-backed) requires a single-turn agent — got a non-final reply", tool.ID),
			}, nil
		}
	}
}

// bareAnswer is the true last resort (upstream's callBestEffort): only the
// CURRENT request reaches the model, never the accumulated transcript — the
// same call best-effort-responder.ts's respond() makes with one string, not
// a message history.
func bareAnswer(ctx workflow.Context, actx workflow.Context, request string) (string, error) {
	var reply string
	err := workflow.ExecuteActivity(actx, activities.CompleteTurnActivityName, activities.CompleteTurnInput{
		SystemPrompt: bareAnswerSystemPrompt,
		Messages:     []llm.Message{{Role: "user", Content: request}},
	}).Get(ctx, &reply)
	return reply, err
}

func bareAnswerWithMeta(ctx workflow.Context, actx workflow.Context, request string, meta TurnMeta) (string, TurnMeta, error) {
	reply, err := bareAnswer(ctx, actx, request)
	return reply, meta, err
}

func toolInScope(toolID string, st *activities.SkillTools) bool {
	return findTool(toolID, st) != nil
}

// findTool resolves an id the planner chose against the skill's own resolved,
// role-visible tools AND agentRefs (ADR 0021, adapted into the same
// ToolDescriptor shape — see adaptAgentAsTool). Only ever called after
// toolInScope, so a nil return would mean the two disagree.
func findTool(toolID string, st *activities.SkillTools) *catalog.ToolDescriptor {
	for i := range st.Tools {
		if st.Tools[i].ID == toolID {
			return &st.Tools[i]
		}
	}
	for _, agent := range st.Agents {
		if agent.ID == toolID {
			tool := adaptAgentAsTool(agent)
			return &tool
		}
	}
	return nil
}

// adaptAgentAsTool adapts a resolved Agent into the same ToolDescriptor shape
// an agent-backed Tool (Tool.spec.agentRef) already produces (upstream ADR
// 0021, graph.ts:1703-1758's loadSkillTools): the planner and dispatch don't
// need to know whether AgentRef came from a Tool wrapper or a Skill's own
// agentRefs.
func adaptAgentAsTool(agent catalog.AgentDescriptor) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID:                agent.ID,
		Description:       agent.Description,
		Input:             agent.Input,
		Output:            agent.Output,
		AllowedRoles:      agent.AllowedRoles,
		Tier:              agent.Tier,
		AgentRef:          agent.ID,
		IdentityProviders: agent.IdentityProviders,
	}
}

func repeatsLastCall(history []activities.ActionRecord, plan activities.PlannedAction) bool {
	if len(history) == 0 {
		return false
	}
	last := history[len(history)-1]
	return last.ToolID == plan.ToolID && last.Input == plan.ToolInput
}
