import type { SkillAccess } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import { deriveKnowledgeBaseSkill } from "./derive.js";
import {
  connectionGetToolId,
  connectionLabel,
  knowledgeBaseFetchToolId,
  knowledgeBaseLabel,
  knowledgeBaseSearchToolId,
  type ConnectionDescriptor,
  type KnowledgeBaseDescriptor,
} from "./types.js";

/**
 * Indexing a KnowledgeBase produces records in TWO collections, visible in
 * opposite ways:
 *
 * - the derived skill goes into `skills` and is meant to be found — it is what
 *   competes for the turn (docs/adr/0039 §2);
 * - its tools go into `tools` HIDDEN: referenceable by the skill that declares
 *   them, never returned by open retrieval. Twenty clients' scoped search and
 *   GET tools competing in the global catalog is exactly the outcome that
 *   design avoids.
 *
 * PARITY: `engines/temporal/internal/catalog/knowledgebase_index.go`.
 */
export interface KnowledgeBaseIndex {
  skills: SkillAccess[];
  tools: ToolDescriptor[];
}

/**
 * Derives everything the catalog needs for the current knowledge bases and
 * connections.
 *
 * Recomputed wholesale rather than incrementally, matching how
 * `deriveSkillAccess` is re-run over the whole snapshot on any catalog change
 * (ADR 0020): a connection change can alter a knowledge base's audience, its
 * tool list and its generated markdown at once, so there is no cheaper correct
 * increment.
 */
export function deriveKnowledgeBaseIndex(
  bases: KnowledgeBaseDescriptor[],
  connections: ReadonlyMap<string, ConnectionDescriptor>,
): KnowledgeBaseIndex {
  const skills: SkillAccess[] = [];
  const tools = new Map<string, ToolDescriptor>();

  for (const kb of bases) {
    const access = deriveKnowledgeBaseSkill(kb, connections);
    skills.push(access);

    for (const tool of knowledgeBaseTools(kb, connections, access.effectiveRoles ?? [])) {
      tools.set(tool.id, tool);
    }
  }

  return { skills, tools: [...tools.values()] };
}

/**
 * The tools a knowledge base implies: its own search and fetch, plus the GET
 * face of every api-enabled member.
 */
export function knowledgeBaseTools(
  kb: KnowledgeBaseDescriptor,
  connections: ReadonlyMap<string, ConnectionDescriptor>,
  roles: string[],
): ToolDescriptor[] {
  const label = knowledgeBaseLabel(kb);

  const tools: ToolDescriptor[] = [
    {
      id: knowledgeBaseSearchToolId(kb.id),
      name: `Search ${label}`,
      description:
        `Search the ${label} knowledge base for passages relevant to a question.` +
        "\n\nInput: A natural-language question, and optionally a list of member " +
        "connection names to narrow the search to." +
        "\nOutput: Ranked passages, each with the title and URL of its source as " +
        "confirmed readable by the calling user, plus how many sources were withheld " +
        "or could not be checked.",
      allowedRoles: roles,
      hidden: true,
    },
    {
      id: knowledgeBaseFetchToolId(kb.id),
      name: `Fetch from ${label}`,
      description:
        `Read a whole document from the ${label} knowledge base, live from its source.` +
        "\n\nInput: The id of a source returned by this knowledge base's search tool." +
        "\nOutput: The current document, as the calling user is permitted to see it.",
      allowedRoles: roles,
      hidden: true,
    },
  ];

  for (const ref of kb.connectionRefs) {
    const connection = connections.get(ref);
    if (!connection?.apiEnabled) continue;
    tools.push(connectionGetTool(connection));
  }

  return tools;
}

/**
 * A Connection's scope-enforced GET face (docs/adr/0038 §5), carrying that
 * connection's OWN roles rather than the knowledge base's union — it is one
 * source's capability, not the composition's. Granting it the union would let a
 * caller read a source they hold no role for.
 */
export function connectionGetTool(connection: ConnectionDescriptor): ToolDescriptor {
  const label = connectionLabel(connection);
  return {
    id: connectionGetToolId(connection.id),
    name: `Read from ${label}`,
    description:
      `Read the current state of a resource in ${label} (${connection.provider}). ` +
      `${connection.description}` +
      "\n\nInput: The id or path of a resource inside this connection's scope. " +
      "Requests outside that scope are refused." +
      "\nOutput: The resource as the source returns it now, for the calling user.",
    allowedRoles: connection.allowedRoles,
    hidden: true,
  };
}
