package activities

import (
	"context"
	"encoding/json"
	"fmt"

	"durable-agents/internal/catalog"
	"durable-agents/internal/vectorstore"
)

const (
	RetrieveSkillsActivityName    = "RetrieveSkills"
	RetrieveAgentsActivityName    = "RetrieveAgents"
	RetrieveToolsActivityName     = "RetrieveTools"
	ResolveSkillToolsActivityName = "ResolveSkillTools"
	ResolveAgentActivityName      = "ResolveAgent"
)

// Caller is the resolved identity a retrieval runs as. Every activity fails
// closed: no subject means no results, and roles gate visibility at the
// store (agent-controller ADR 0004/0008 discipline).
type Caller struct {
	Subject string   `json:"subject"`
	Roles   []string `json:"roles,omitempty"`

	// Principal is the stable per-human credential key, when established
	// (upstream ADR 0030 §6 / 0031). Subject stays what sessions and RBAC key
	// on; only durable per-user credentials move to the principal.
	Principal string `json:"principal,omitempty"`

	// PerUser asserts that Subject identifies ONE human. Set only by a
	// resolver that structurally knows — see authz.Identity for why inferring
	// it is unsound in the direction that leaks.
	PerUser bool `json:"perUser,omitempty"`
}

type RetrieveInput struct {
	Caller  Caller `json:"caller"`
	Request string `json:"request"`
	TopK    int    `json:"topK,omitempty"`
}

const defaultTopK = 3

type ResolveSkillToolsInput struct {
	Caller  Caller `json:"caller"`
	SkillID string `json:"skillId"`
}

type ResolveAgentInput struct {
	Caller  Caller `json:"caller"`
	AgentID string `json:"agentId"`
}

// SkillTools is a selected skill plus its resolved, role-visible tools and
// agents — everything the planner needs for a turn.
type SkillTools struct {
	Skill  catalog.SkillDescriptor   `json:"skill"`
	Tools  []catalog.ToolDescriptor  `json:"tools,omitempty"`
	Agents []catalog.AgentDescriptor `json:"agents,omitempty"`
}

type RetrievalActivities struct {
	Collections vectorstore.Collections
}

// RetrieveSkills returns the top-k role-visible skills for the request.
func (a *RetrievalActivities) RetrieveSkills(ctx context.Context, in RetrieveInput) ([]catalog.SkillDescriptor, error) {
	if in.Caller.Subject == "" {
		return nil, nil
	}
	hits, err := a.Collections.Skills.Query(ctx, in.Request, in.Caller.Roles, topK(in.TopK))
	if err != nil {
		return nil, err
	}
	return decodeHits[catalog.SkillDescriptor](hits)
}

// RetrieveAgents returns the top-k role-visible delegable agents.
func (a *RetrievalActivities) RetrieveAgents(ctx context.Context, in RetrieveInput) ([]catalog.AgentDescriptor, error) {
	if in.Caller.Subject == "" {
		return nil, nil
	}
	hits, err := a.Collections.Agents.Query(ctx, in.Request, in.Caller.Roles, topK(in.TopK))
	if err != nil {
		return nil, err
	}
	return decodeHits[catalog.AgentDescriptor](hits)
}

// ResolveSkillTools re-fetches a skill by id under the caller's current
// roles (fail closed — supports session continuity re-checks) and resolves
// its declared tool/agent refs directly, role-checked again, with no
// re-ranking (ADR 0008).
func (a *RetrievalActivities) ResolveSkillTools(ctx context.Context, in ResolveSkillToolsInput) (*SkillTools, error) {
	if in.Caller.Subject == "" || in.SkillID == "" {
		return nil, nil
	}

	skillHits, err := a.Collections.Skills.GetByIDs(ctx, []string{in.SkillID}, in.Caller.Roles)
	if err != nil {
		return nil, err
	}
	if len(skillHits) == 0 {
		return nil, nil // not visible to this caller (or gone) — never an error
	}
	skills, err := decodeHits[catalog.SkillDescriptor](skillHits)
	if err != nil {
		return nil, err
	}
	result := &SkillTools{Skill: skills[0]}

	if len(result.Skill.ToolIDs) > 0 {
		toolHits, err := a.Collections.Tools.GetByIDs(ctx, result.Skill.ToolIDs, in.Caller.Roles)
		if err != nil {
			return nil, err
		}
		if result.Tools, err = decodeHits[catalog.ToolDescriptor](toolHits); err != nil {
			return nil, err
		}
	}
	if len(result.Skill.AgentIDs) > 0 {
		agentHits, err := a.Collections.Agents.GetByIDs(ctx, result.Skill.AgentIDs, in.Caller.Roles)
		if err != nil {
			return nil, err
		}
		if result.Agents, err = decodeHits[catalog.AgentDescriptor](agentHits); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// RetrieveTools returns the top-k role-visible tools for the request from the
// WHOLE catalog, unmediated by any skill.
//
// Deliberately separate from ResolveSkillTools, which resolves a skill's own
// declared refs. This one backs the two places that ask "is there any tool
// out there for this?" — the no-match fallback, and the out-of-scope guard on
// active-skill continuity. Its results are candidates, not selections: every
// caller runs them past CheckToolFit before the planner sees them.
func (a *RetrievalActivities) RetrieveTools(ctx context.Context, in RetrieveInput) ([]catalog.ToolDescriptor, error) {
	if in.Caller.Subject == "" {
		return nil, nil
	}
	hits, err := a.Collections.Tools.Query(ctx, in.Request, in.Caller.Roles, topK(in.TopK))
	if err != nil {
		return nil, err
	}
	return decodeHits[catalog.ToolDescriptor](hits)
}

// ResolveAgent fetches one agent by id under the caller's CURRENT roles,
// returning nil when it is gone or no longer visible — never an error.
//
// Used by the IntegrationRoute bypass (upstream ADR 0024), which names an
// agent directly instead of retrieving one. The RBAC re-check is the point:
// a route is operator config, and config saying "dispatch to this agent"
// must not become a way around the roles that gate reaching it normally.
func (a *RetrievalActivities) ResolveAgent(ctx context.Context, in ResolveAgentInput) (*catalog.AgentDescriptor, error) {
	if in.Caller.Subject == "" || in.AgentID == "" {
		return nil, nil
	}
	hits, err := a.Collections.Agents.GetByIDs(ctx, []string{in.AgentID}, in.Caller.Roles)
	if err != nil {
		return nil, err
	}
	if len(hits) == 0 {
		return nil, nil
	}
	agents, err := decodeHits[catalog.AgentDescriptor](hits)
	if err != nil {
		return nil, err
	}
	return &agents[0], nil
}

func topK(k int) int {
	if k <= 0 {
		return defaultTopK
	}
	return k
}

func decodeHits[T any](hits []vectorstore.Hit) ([]T, error) {
	out := make([]T, len(hits))
	for i, h := range hits {
		if err := json.Unmarshal(h.Descriptor, &out[i]); err != nil {
			return nil, fmt.Errorf("decode descriptor %s: %w", h.ID, err)
		}
	}
	return out, nil
}
