import type { AgentDescriptor } from "../agents/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { SkillAccess, SkillDescriptor } from "./types.js";

/**
 * Derives each skill's retrieval audience from the tools AND agents it
 * references (docs/adr/0011, extended by ADR 0021 to agentIds). Skills carry
 * no allowedRoles of their own — they are trusted markdown, not capability;
 * all RBAC lives on the dangerous things (tools, agents). A skill is visible
 * to a caller iff the caller can use EVERY tool/agent the skill declares,
 * i.e. the intersection of their allowedRoles:
 *
 * - no `toolIds`/`agentIds` (respond-only skill) -> `effectiveRoles: null`
 *   (unrestricted — any caller with a resolved identity may select it);
 * - a `toolIds`/`agentIds` entry not present in the corresponding catalog ->
 *   fail closed: `effectiveRoles: []` (never retrievable) rather than
 *   silently ignoring the missing ref, since the skill's markdown instructs
 *   the planner to call it;
 * - a disjoint intersection also yields `[]` — the skill is authorable but
 *   unreachable, surfaced via console.error instead of a runtime dead-end.
 *
 * Pure function; called at startup between the tool/agent-catalog load and
 * the skill upsert, and again by index.ts's debounced `scheduleSkillReindex`
 * whenever a Tool/LocalTool/Agent/Skill watch event fires (ADR 0020) — so a
 * Tool/Agent CR's allowedRoles change now reaches skill visibility within
 * the debounce window instead of only on the next orchestrator restart
 * (superseding the staleness ADR 0011 originally called out).
 */
export function deriveSkillAccess(
  skills: SkillDescriptor[],
  tools: ToolDescriptor[],
  agents: AgentDescriptor[],
): SkillAccess[] {
  const rolesByToolId = new Map(tools.map((tool) => [tool.id, tool.allowedRoles]));
  const rolesByAgentId = new Map(agents.map((agent) => [agent.id, agent.allowedRoles]));

  return skills.map((skill) => {
    if (skill.toolIds.length === 0 && skill.agentIds.length === 0) {
      return { skill, effectiveRoles: null };
    }

    let effective: string[] | undefined;
    for (const toolId of skill.toolIds) {
      const toolRoles = rolesByToolId.get(toolId);
      if (toolRoles === undefined) {
        console.error(
          `skill "${skill.id}" references tool "${toolId}" which is not in the tool catalog -- ` +
            "failing closed: the skill will not be retrievable by anyone until the tool exists",
        );
        return { skill, effectiveRoles: [] };
      }
      effective = effective === undefined ? [...toolRoles] : effective.filter((role) => toolRoles.includes(role));
    }
    for (const agentId of skill.agentIds) {
      const agentRoles = rolesByAgentId.get(agentId);
      if (agentRoles === undefined) {
        console.error(
          `skill "${skill.id}" references agent "${agentId}" which is not in the agent catalog -- ` +
            "failing closed: the skill will not be retrievable by anyone until the agent exists",
        );
        return { skill, effectiveRoles: [] };
      }
      effective = effective === undefined ? [...agentRoles] : effective.filter((role) => agentRoles.includes(role));
    }

    if (effective !== undefined && effective.length === 0) {
      console.error(
        `skill "${skill.id}" has no roles that can use ALL of its tools/agents (disjoint allowedRoles across ` +
          `[${[...skill.toolIds, ...skill.agentIds].join(", ")}]) -- the skill will not be retrievable by anyone`,
      );
    }
    return { skill, effectiveRoles: effective ?? [] };
  });
}
