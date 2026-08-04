package catalog

// DeriveSkillAccess computes a skill's retrieval audience (agent-controller
// ADR 0011: skills carry no RBAC of their own — "skills aren't dangerous,
// tools are"):
//
//   - no tool/agent refs        → Unrestricted (any resolved identity)
//   - any dangling ref          → EffectiveRoles [] (visible to no one)
//   - otherwise                 → intersection of every ref's allowedRoles
//     (empty intersection also fails closed)
func DeriveSkillAccess(skill SkillDescriptor, tools map[string]ToolDescriptor, agents map[string]AgentDescriptor) SkillDescriptor {
	skill.Unrestricted = false
	skill.EffectiveRoles = nil

	if len(skill.ToolIDs) == 0 && len(skill.AgentIDs) == 0 {
		skill.Unrestricted = true
		return skill
	}

	roleSets := make([][]string, 0, len(skill.ToolIDs)+len(skill.AgentIDs))
	for _, id := range skill.ToolIDs {
		tool, ok := tools[id]
		if !ok {
			skill.EffectiveRoles = []string{}
			return skill
		}
		roleSets = append(roleSets, tool.AllowedRoles)
	}
	for _, id := range skill.AgentIDs {
		agent, ok := agents[id]
		if !ok {
			skill.EffectiveRoles = []string{}
			return skill
		}
		roleSets = append(roleSets, agent.AllowedRoles)
	}

	skill.EffectiveRoles = intersect(roleSets)
	return skill
}

func intersect(sets [][]string) []string {
	counts := map[string]int{}
	for _, set := range sets {
		seen := map[string]bool{}
		for _, role := range set {
			if !seen[role] {
				seen[role] = true
				counts[role]++
			}
		}
	}
	out := []string{}
	for _, role := range sets[0] {
		if counts[role] == len(sets) {
			counts[role] = 0 // dedupe repeats in sets[0]
			out = append(out, role)
		}
	}
	return out
}
