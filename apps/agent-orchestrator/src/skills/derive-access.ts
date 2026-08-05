import type { AgentDescriptor } from "../agents/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { SkillAccess, SkillDescriptor } from "./types.js";

/**
 * Intersects a running set (`undefined` = "no constraint yet") with `next`.
 * Shared by the role and principal derivations below so both fold their
 * per-ref sets the same way: the first constraint seeds the set, every later
 * one narrows it.
 */
function intersect(running: string[] | undefined, next: string[]): string[] {
  return running === undefined ? [...next] : running.filter((v) => next.includes(v));
}

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
 * ABAC private-scoping (docs/adr/0037) is derived on the SAME principle, in a
 * second, independent axis — `effectivePrincipals`:
 *
 * - the skill's OWN `allowedPrincipals`, intersected with the
 *   `allowedPrincipals` of every referenced tool/agent that is ITSELF private
 *   (a public tool/agent adds no principal constraint);
 * - no private skill and no private referenced tool/agent -> `null`
 *   (unrestricted by ABAC — today's behavior);
 * - a non-empty result -> the skill is private to exactly those principals;
 * - an empty result with at least one private input -> disjoint, so the skill
 *   is authorable but unreachable (mirrors the disjoint-`effectiveRoles`
 *   case), surfaced via console.error.
 *
 * Intersecting (rather than unioning) is what keeps a skill from ever widening
 * a private tool's audience: since the planner may invoke any referenced tool,
 * a caller must be permitted on ALL of them, exactly as with roles.
 *
 * Pure function; called at startup between the tool/agent-catalog load and
 * the skill upsert, and again by index.ts's debounced `scheduleSkillReindex`
 * whenever a Tool/LocalTool/Agent/Skill watch event fires (ADR 0020) — so a
 * Tool/Agent CR's allowedRoles/allowedPrincipals change now reaches skill
 * visibility within the debounce window instead of only on the next
 * orchestrator restart (superseding the staleness ADR 0011 originally called
 * out).
 */
export function deriveSkillAccess(
  skills: SkillDescriptor[],
  tools: ToolDescriptor[],
  agents: AgentDescriptor[],
): SkillAccess[] {
  const rolesByToolId = new Map(tools.map((tool) => [tool.id, tool.allowedRoles]));
  const rolesByAgentId = new Map(agents.map((agent) => [agent.id, agent.allowedRoles]));
  const principalsByToolId = new Map(tools.map((tool) => [tool.id, tool.allowedPrincipals ?? []]));
  const principalsByAgentId = new Map(agents.map((agent) => [agent.id, agent.allowedPrincipals ?? []]));

  return skills.map((skill) => {
    // ── ABAC axis (docs/adr/0037): independent of roles, so it is derived
    // even for a respond-only skill (which may still be privately scoped to
    // its owner). A referenced tool/agent constrains only when it is itself
    // private (non-empty allowedPrincipals). A missing ref is handled by the
    // roles axis below (fail-closed to effectiveRoles: []), so it need not be
    // re-guarded here.
    let principals: string[] | undefined;
    if (skill.allowedPrincipals && skill.allowedPrincipals.length > 0) {
      principals = intersect(principals, skill.allowedPrincipals);
    }
    for (const toolId of skill.toolIds) {
      const toolPrincipals = principalsByToolId.get(toolId);
      if (toolPrincipals && toolPrincipals.length > 0) principals = intersect(principals, toolPrincipals);
    }
    for (const agentId of skill.agentIds) {
      const agentPrincipals = principalsByAgentId.get(agentId);
      if (agentPrincipals && agentPrincipals.length > 0) principals = intersect(principals, agentPrincipals);
    }
    const effectivePrincipals = principals ?? null;
    if (effectivePrincipals !== null && effectivePrincipals.length === 0) {
      console.error(
        `skill "${skill.id}" is privately scoped to no one (disjoint allowedPrincipals across the skill and ` +
          `[${[...skill.toolIds, ...skill.agentIds].join(", ")}]) -- the skill will not be retrievable by anyone`,
      );
    }

    // ── RBAC axis (docs/adr/0011).
    if (skill.toolIds.length === 0 && skill.agentIds.length === 0) {
      return { skill, effectiveRoles: null, effectivePrincipals };
    }

    let effective: string[] | undefined;
    for (const toolId of skill.toolIds) {
      const toolRoles = rolesByToolId.get(toolId);
      if (toolRoles === undefined) {
        console.error(
          `skill "${skill.id}" references tool "${toolId}" which is not in the tool catalog -- ` +
            "failing closed: the skill will not be retrievable by anyone until the tool exists",
        );
        return { skill, effectiveRoles: [], effectivePrincipals };
      }
      effective = intersect(effective, toolRoles);
    }
    for (const agentId of skill.agentIds) {
      const agentRoles = rolesByAgentId.get(agentId);
      if (agentRoles === undefined) {
        console.error(
          `skill "${skill.id}" references agent "${agentId}" which is not in the agent catalog -- ` +
            "failing closed: the skill will not be retrievable by anyone until the agent exists",
        );
        return { skill, effectiveRoles: [], effectivePrincipals };
      }
      effective = intersect(effective, agentRoles);
    }

    if (effective !== undefined && effective.length === 0) {
      console.error(
        `skill "${skill.id}" has no roles that can use ALL of its tools/agents (disjoint allowedRoles across ` +
          `[${[...skill.toolIds, ...skill.agentIds].join(", ")}]) -- the skill will not be retrievable by anyone`,
      );
    }
    return { skill, effectiveRoles: effective ?? [], effectivePrincipals };
  });
}
