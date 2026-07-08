import type { ToolDescriptor } from "../tool-descriptor.js";
import type { SkillAccess, SkillDescriptor } from "./types.js";

/**
 * Derives each skill's retrieval audience from the tools it references
 * (docs/adr/0011). Skills carry no allowedRoles of their own — they are
 * trusted markdown, not capability; all RBAC lives on the dangerous things
 * (tools). A skill is visible to a caller iff the caller can use EVERY tool
 * the skill declares, i.e. the intersection of the tools' allowedRoles:
 *
 * - no `toolIds` (respond-only skill) -> `effectiveRoles: null`
 *   (unrestricted — any caller with a resolved identity may select it);
 * - a `toolIds` entry not present in the tool catalog -> fail closed:
 *   `effectiveRoles: []` (never retrievable) rather than silently ignoring
 *   the missing tool, since the skill's markdown instructs the planner to
 *   call it;
 * - a disjoint intersection also yields `[]` — the skill is authorable but
 *   unreachable, surfaced via console.error instead of a runtime dead-end.
 *
 * Pure function; called once at startup between the tool-catalog load and
 * the skill upsert (see index.ts). Because it runs at index time, a Tool
 * CR's allowedRoles change only affects skill visibility after an
 * orchestrator restart — same one-shot-at-startup staleness as the rest of
 * the catalog, but now applying to authorization, so it's called out
 * explicitly in ADR 0011.
 */
export function deriveSkillAccess(skills: SkillDescriptor[], tools: ToolDescriptor[]): SkillAccess[] {
  const rolesByToolId = new Map(tools.map((tool) => [tool.id, tool.allowedRoles]));

  return skills.map((skill) => {
    if (skill.toolIds.length === 0) {
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

    if (effective !== undefined && effective.length === 0) {
      console.error(
        `skill "${skill.id}" has no roles that can use ALL of its tools (disjoint allowedRoles across ` +
          `[${skill.toolIds.join(", ")}]) -- the skill will not be retrievable by anyone`,
      );
    }
    return { skill, effectiveRoles: effective ?? [] };
  });
}
