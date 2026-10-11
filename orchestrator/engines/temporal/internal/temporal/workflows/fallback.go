package workflows

import (
	"strings"

	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// fallbackToolTopK bounds the full-catalog candidate sweep, matching
// upstream's default.
const fallbackToolTopK = 3

// SelfImprovementFooter marks a turn that no skill or agent covered, so the
// user can ask for one to be authored. Verbatim from upstream.
const SelfImprovementFooter = "\n\n---\nNo existing skill or agent matched this request, so it was handled ad-hoc. " +
	"Ask me to run the self-improvement skill if you'd like a permanent skill added for this next time."

// stripSelfImprovementFooter removes the footer before a reply is folded into
// durable history.
//
// The footer is a UI hint for the human, not content. Left in the transcript
// it re-enters every later turn's prompt, and its "no existing skill or agent
// matched this request" wording biases the next turn's skill/agent/tool
// selection toward repeating "no match" even when the new request plainly
// fits a real skill. Upstream strips it on the way back in (buildAgentRequest);
// here the transcript is workflow state, so it is stripped on the way in.
func stripSelfImprovementFooter(reply string) string {
	return strings.TrimSuffix(reply, SelfImprovementFooter)
}

// fallbackToolMarkdown stands in for a real Skill's authored markdown when
// the planner is asked to pick from raw catalog entries. A real skill's
// markdown says when to use which tool and when not to; a request that
// reaches here has none of that, so the instruction is to be conservative.
const fallbackToolMarkdown = "No dedicated skill matched this request. You are deciding, from the raw tool catalog below (with no " +
	"authored procedural guidance for how these tools relate or when to use them), whether exactly one of " +
	"them is an unambiguous fit for the request. " +
	"Only call a tool when its description is a clear, direct match — if the fit is unclear, or the request " +
	"would need multiple tools or steps to satisfy, decline (respond) rather than force a guess; this request " +
	"will get a plain best-effort answer instead if no tool is called."

// fitCandidates runs CheckToolFit over candidates concurrently and returns
// the survivors in their original ranking order.
//
// Concurrent, not sequential: these are N independent judgments and a turn
// that already missed the catalog should not pay for them serially. Futures
// are started in order and collected in order, so the result is deterministic
// regardless of which activity finishes first.
func fitCandidates(ctx workflow.Context, actx workflow.Context, request string, candidates []catalog.ToolDescriptor) []catalog.ToolDescriptor {
	if len(candidates) == 0 {
		return nil
	}
	futures := make([]workflow.Future, len(candidates))
	for i, tool := range candidates {
		futures[i] = workflow.ExecuteActivity(actx, activities.CheckToolFitActivityName, activities.CheckToolFitInput{
			Request: request,
			Tool:    tool,
		})
	}

	logger := workflow.GetLogger(ctx)
	var fitted []catalog.ToolDescriptor
	for i, f := range futures {
		var fits bool
		if err := f.Get(ctx, &fits); err != nil {
			// Fail closed, same as the checker's own default: a gate that
			// errored has not said yes.
			logger.Warn("tool fit check failed; treating as no fit", "toolId", candidates[i].ID, "error", err)
			continue
		}
		if fits {
			fitted = append(fitted, candidates[i])
		}
	}
	return fitted
}

// retrieveCatalogTools sweeps the whole role-visible catalog for the request.
func retrieveCatalogTools(ctx workflow.Context, actx workflow.Context, in TurnInput) []catalog.ToolDescriptor {
	var tools []catalog.ToolDescriptor
	if err := workflow.ExecuteActivity(actx, activities.RetrieveToolsActivityName, activities.RetrieveInput{
		Caller:  in.Caller,
		Request: in.Message,
		TopK:    fallbackToolTopK,
	}).Get(ctx, &tools); err != nil {
		workflow.GetLogger(ctx).Warn("catalog tool retrieval failed", "error", err)
		return nil
	}
	return tools
}

// hasOutOfScopeToolMatch guards the active-skill fit check against a failure
// mode that check cannot see.
//
// The fit checker only judges topic continuity — "is this still the same
// task?" — so a turn that names a DIFFERENT capability mid-task ("use your
// kubectl access to debug this", while still inside a web-search skill) reads
// as "still fits". The turn is then answered by a skill whose tools could
// never satisfy it, and the user gets a flat "I can't do that" from a system
// that in fact can. A hit here means this turn needs full retrieval, not the
// tools already loaded.
// Scope is the union of what the skill DECLARES and what actually resolved
// for this caller. Upstream compares against the declared refs alone; taking
// both means neither an RBAC-hidden ref nor a descriptor whose refs were
// never populated can make one of the skill's own tools look foreign and
// send an ordinary continuing turn back through full retrieval.
func hasOutOfScopeToolMatch(ctx workflow.Context, actx workflow.Context, in TurnInput, skill *activities.SkillTools) bool {
	inSkill := make(map[string]bool, len(skill.Skill.ToolIDs)+len(skill.Tools))
	for _, id := range skill.Skill.ToolIDs {
		inSkill[id] = true
	}
	for _, tool := range skill.Tools {
		inSkill[tool.ID] = true
	}

	var outOfScope []catalog.ToolDescriptor
	for _, tool := range retrieveCatalogTools(ctx, actx, in) {
		if !inSkill[tool.ID] {
			outOfScope = append(outOfScope, tool)
		}
	}
	return len(fitCandidates(ctx, actx, in.Message, outOfScope)) > 0
}

// planToolCall runs the planner over a specific, non-empty set of tools using
// the fallback markdown and returns the one tool call it chose (with the input
// it constructed), if any. Shared by selectFallbackTool (over the whole
// fit-checked catalog, plus any caller-supplied tools) and the delegate
// selector's tool branch (over the single tool it deliberately picked, with
// no caller tools on offer there) — both need the planner to turn a bare tool
// + request into a concrete call, and neither may trust a hallucinated id.
//
// Caller-supplied tools (ADR 0035) are appended to the candidate list
// UNFILTERED by the fit check (upstream's selectFallbackTool, graph.ts:
// 1162-1196): that gate exists because a catalog-wide embedding search
// surfaces loose keyword overlap the caller never asked about, whereas a
// caller tool was explicitly supplied for this very conversation and was
// already relevance-ranked by the caller offering it.
func planToolCall(
	ctx workflow.Context,
	actx workflow.Context,
	in TurnInput,
	tools []catalog.ToolDescriptor,
	offeredCallerTools []callertools.Descriptor,
	callerToolRequired bool,
) (catalog.ToolDescriptor, string, bool, *callertools.PendingCall) {
	if len(tools) == 0 && len(offeredCallerTools) == 0 {
		return catalog.ToolDescriptor{}, "", false, nil
	}

	var plan activities.PlannedAction
	if err := workflow.ExecuteActivity(actx, activities.PlanActionActivityName, activities.PlanActionInput{
		Request:            in.Message,
		SkillMarkdown:      fallbackToolMarkdown,
		Tools:              tools,
		CallerTools:        offeredCallerTools,
		CallerToolRequired: callerToolRequired,
	}).Get(ctx, &plan); err != nil {
		workflow.GetLogger(ctx).Warn("fallback planner failed; answering bare", "error", err)
		return catalog.ToolDescriptor{}, "", false, nil
	}
	if plan.Action != activities.ActionCallTool {
		return catalog.ToolDescriptor{}, "", false, nil
	}

	if callertools.IsID(plan.ToolID) {
		if call, ok, err := pendingCallerCall(ctx, offeredCallerTools, plan); err == nil && ok {
			return catalog.ToolDescriptor{}, "", false, &call
		}
		return catalog.ToolDescriptor{}, "", false, nil
	}

	// Re-validate against the offered set, exactly as the skill loop does: a
	// planner may not invent a tool id.
	for _, tool := range tools {
		if tool.ID == plan.ToolID {
			return tool, plan.ToolInput, true, nil
		}
	}
	return catalog.ToolDescriptor{}, "", false, nil
}

// selectFallbackTool looks for one tool that unambiguously fits a request no
// skill or agent matched. Returns false when nothing passes, which is the
// common and expected outcome.
func selectFallbackTool(ctx workflow.Context, actx workflow.Context, in TurnInput) (catalog.ToolDescriptor, string, bool, *callertools.PendingCall) {
	fitted := fitCandidates(ctx, actx, in.Message, retrieveCatalogTools(ctx, actx, in))
	return planToolCall(ctx, actx, in, fitted, in.CallerTools, in.CallerToolRequired)
}

// noMatchFallback is the whole cascade for a turn that matched no skill and
// no agent: try one deterministic, relevance-gated tool call, and failing
// that give a plain conversational answer. Never a hardcoded fallback agent.
//
// Either way the reply carries the self-improvement footer — the point of
// this path is that the request worked, but nothing in the catalog covers it
// yet.
func noMatchFallback(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	meta *TurnMeta,
	note func(string),
) (string, TurnMeta, []callertools.PendingCall, error) {
	if in.Caller.Subject != "" {
		tool, toolInput, ok, pendingCall := selectFallbackTool(ctx, actx, in)
		if pendingCall != nil {
			meta.Path = "fallback-tool"
			meta.ToolCalls = append(meta.ToolCalls, callertools.ID(pendingCall.Name))
			note("Asking your client to run " + pendingCall.Name)
			return "", *meta, []callertools.PendingCall{*pendingCall}, nil
		}
		if ok {
			reply, m, err := runFallbackTool(ctx, actx, state, in, tool, toolInput, meta, note)
			return reply, m, nil, err
		}
	}

	meta.Path = "fallback-bare"
	reply, err := bareAnswer(ctx, actx, in.Message)
	if err != nil {
		return "", *meta, nil, err
	}
	return reply + SelfImprovementFooter, *meta, nil, nil
}

// runFallbackTool runs a tool reached ad-hoc because no skill or agent matched
// (meta.Path "fallback-tool"). The self-improvement footer is appended: the
// point of this path is that the request worked, but nothing in the catalog
// covers it yet.
func runFallbackTool(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	tool catalog.ToolDescriptor,
	toolInput string,
	meta *TurnMeta,
	note func(string),
) (string, TurnMeta, error) {
	meta.Path = "fallback-tool"
	return runToolCall(ctx, actx, state, in, tool, toolInput, "No skill matched; trying "+tool.ID+"…", SelfImprovementFooter, meta, note)
}

// runSelectedTool runs a bare tool the delegate selector chose as the best fit
// for the request (ADR 0037) — a first-class match, NOT the ad-hoc no-match
// fallback. It uses meta.Path "tool" and appends NO self-improvement footer:
// telling the user nothing matched would contradict the fact that this tool
// was deliberately selected over the skill/agent candidates.
func runSelectedTool(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	tool catalog.ToolDescriptor,
	toolInput string,
	meta *TurnMeta,
	note func(string),
) (string, TurnMeta, error) {
	meta.Path = "tool"
	return runToolCall(ctx, actx, state, in, tool, toolInput, "Using tool "+tool.ID+"…", "", meta, note)
}

// runToolCall executes one already-chosen tool and composes the reply, shared
// by the ad-hoc fallback and the first-class delegate-selected paths. footer
// is appended to every reply shape when non-empty; the caller sets meta.Path
// before calling. The two paths differ only in that footer and their opening
// progress note — the tool's own contract does not change with how it was
// selected.
func runToolCall(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	tool catalog.ToolDescriptor,
	toolInput string,
	startNote string,
	footer string,
	meta *TurnMeta,
	note func(string),
) (string, TurnMeta, error) {
	// The identity gate applies here too: a Tool reached this way must not skip
	// a check a Tool reached through a skill has to pass.
	creds, refusal := toolCredentials(ctx, actx, in, tool)
	if refusal != "" {
		return refusal, *meta, nil
	}

	meta.ToolCalls = append(meta.ToolCalls, tool.ID)
	note(startNote)

	outcome, err := runToolWithContinuation(ctx, actx, state, in, tool, toolInput, "", creds, note)
	if err != nil {
		return "", *meta, err
	}
	if !outcome.Succeeded {
		note(tool.ID + " failed: " + outcome.ErrorCode)
		return "I couldn't complete that: " + tool.ID + " failed (" + outcome.ErrorCode + ": " + outcome.ErrorMessage + ")." + footer, *meta, nil
	}

	// No compose step here: upstream's composeResponse no-ops without a
	// selectedSkill (graph.ts:2058), which neither the fallback-tool nor the
	// first-class tool path ever sets — so TS never lets an LLM add
	// prefix/suffix narration around this result. Only the raw result plus
	// whichever footer the caller chose (SelfImprovementFooter for the
	// fallback path, none for the first-class one).
	return outcome.Result + footer, *meta, nil
}
