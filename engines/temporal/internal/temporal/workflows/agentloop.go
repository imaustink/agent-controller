package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/continuation"
	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// maxToolSteps bounds the plan⇄runTool loop per turn (upstream MAX_TOOL_STEPS).
const maxToolSteps = 4

// TurnMeta reports what the agent loop did, for TurnResult/debugging.
type TurnMeta struct {
	// Path is how this turn reached its target:
	//   bare             — no capability needed (ADR 0019), or no identity
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
			reply := handleAgentUp(ctx, state, state.ActiveAgentID, state.ActiveAgentWorkflowID, note)
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
				reply, m, err := delegateToAgent(ctx, actx, state, in, *agent, &meta, note)
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
			reply, err := bareAnswer(ctx, actx, state)
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
		if len(skills) == 0 && len(agents) == 0 {
			reply, m, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, nil, err
		}

		// 4. Selection: skill vs agent when both kinds are on the table,
		// plain skill selection otherwise.
		var skillID string
		if len(agents) > 0 {
			var choice activities.DelegateChoice
			if err := workflow.ExecuteActivity(actx, activities.SelectDelegateActivityName, activities.SelectDelegateInput{
				Request: in.Message,
				Skills:  skills,
				Agents:  agents,
			}).Get(ctx, &choice); err != nil {
				logger.Warn("delegate selection failed; answering bare", "error", err)
			}
			if choice.Kind == activities.DelegateAgent {
				if agent := findAgent(choice.ID, agents); agent != nil {
					reply, m, err := delegateToAgent(ctx, actx, state, in, *agent, &meta, note)
					return reply, m, nil, err
				}
			}
			skillID = ""
			if choice.Kind == activities.DelegateSkill {
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
			reply, m, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, nil, err
		}

		// 5. Resolve the skill's declared tools directly (no re-ranking),
		// RBAC re-checked (ADR 0008).
		if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: skillID,
		}).Get(ctx, &skillTools); err != nil || skillTools == nil {
			reply, m, err := noMatchFallback(ctx, actx, state, in, &meta, note)
			return reply, m, nil, err
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
			Tools:              skillTools.Tools,
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
			if call, ok := pendingCallerCall(ctx, callerTools, plan); ok {
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

		// Identity gate for a container Tool acting as the calling human
		// (ADR 0032 §5). Before this, only an agent-backed Tool had one.
		creds, refusal := toolCredentials(ctx, actx, in, *findTool(plan.ToolID, skillTools))
		if refusal != "" {
			note(plan.ToolID + " needs a linked account")
			return refusal, meta, nil, nil
		}

		note("Running " + plan.ToolID + "…")
		outcome, err := runToolWithContinuation(ctx, state, plan.ToolID, plan.ToolInput, creds, note)
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
	reply, m, err := bareAnswerWithMeta(ctx, actx, state, meta)
	return reply, m, nil, err
}

// runToolWithContinuation is one tool call with ADR 0017's resume token
// handling folded in: the tool's own stored token is prepended to its input,
// and any token the tool returns is banked and stripped off the result.
//
// Stripping happens BEFORE the result reaches planner history, composition,
// or the reply, so resume state never enters the transcript or a prompt. Both
// the skill loop and the no-match fallback go through here, because a tool
// does not change its contract based on how it was selected.
func runToolWithContinuation(
	ctx workflow.Context,
	state *ConversationState,
	toolID, toolInput string,
	creds credentials,
	note func(string),
) (ToolOutcome, error) {
	if token := state.ToolContinuations[toolID]; token != "" {
		toolInput = continuation.Prepend(token, toolInput)
	}

	outcome, err := runTool(ctx, RunToolParams{
		ToolRef:              toolID,
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
	if err != nil || !outcome.Succeeded {
		return outcome, err
	}

	token, stripped := continuation.Extract(outcome.Result)
	if token != "" {
		if state.ToolContinuations == nil {
			state.ToolContinuations = map[string]string{}
		}
		state.ToolContinuations[toolID] = token
	}
	outcome.Result = stripped
	return outcome, nil
}

func bareAnswer(ctx workflow.Context, actx workflow.Context, state *ConversationState) (string, error) {
	var reply string
	err := workflow.ExecuteActivity(actx, activities.CompleteTurnActivityName, activities.CompleteTurnInput{
		SystemPrompt: systemPrompt,
		Messages:     toLLMMessages(state.History),
	}).Get(ctx, &reply)
	return reply, err
}

func bareAnswerWithMeta(ctx workflow.Context, actx workflow.Context, state *ConversationState, meta TurnMeta) (string, TurnMeta, error) {
	reply, err := bareAnswer(ctx, actx, state)
	return reply, meta, err
}

func toolInScope(toolID string, st *activities.SkillTools) bool {
	return findTool(toolID, st) != nil
}

// findTool resolves an id the planner chose against the skill's own resolved,
// role-visible tools. Only ever called after toolInScope, so a nil return
// would mean the two disagree.
func findTool(toolID string, st *activities.SkillTools) *catalog.ToolDescriptor {
	for i := range st.Tools {
		if st.Tools[i].ID == toolID {
			return &st.Tools[i]
		}
	}
	return nil
}

func repeatsLastCall(history []activities.ActionRecord, plan activities.PlannedAction) bool {
	if len(history) == 0 {
		return false
	}
	last := history[len(history)-1]
	return last.ToolID == plan.ToolID && last.Input == plan.ToolInput
}
