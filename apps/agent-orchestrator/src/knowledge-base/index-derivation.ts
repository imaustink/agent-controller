import type { SkillAccess } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import { deriveKnowledgeBaseSkill } from "./derive.js";
import type { KnowledgeBaseExecMember, KnowledgeBaseExecSpec } from "./exec.js";
import {
  corpusGetToolId,
  connectionLabel,
  knowledgeBaseLabel,
  knowledgeBaseReadToolId,
  knowledgeBaseSearchToolId,
  type CorpusDescriptor,
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
  connections: ReadonlyMap<string, CorpusDescriptor>,
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
 * The tools a knowledge base implies: its own search, plus the GET face of
 * every api-enabled member.
 *
 * A `/fetch` tool is deliberately NOT offered yet. The whole-document read it
 * would provide has no dispatch path — both engines route every
 * `knowledgeBaseExec` to search — and building the real one means a source
 * reader against Atlassian's actual API shapes, the same adapter layer ADR 0040
 * defers. Offering it before then would steer the planner into a call that
 * silently degrades to a similarity search over the source id. The
 * `KnowledgeBaseExecSpec.operation` field stays as scaffolding for that
 * deferred path, and dispatch fails closed on any operation but `search`.
 */
export function knowledgeBaseTools(
  kb: KnowledgeBaseDescriptor,
  connections: ReadonlyMap<string, CorpusDescriptor>,
  roles: string[],
): ToolDescriptor[] {
  const label = knowledgeBaseLabel(kb);
  const exec = (operation: "search" | "read"): KnowledgeBaseExecSpec => ({
    knowledgeBaseId: kb.id,
    displayName: label,
    operation,
    members: execMembers(kb, connections),
    disclosePartialVisibility: kb.disclosePartialVisibility,
  });

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
      knowledgeBaseExec: exec("search"),
    },
  ];

  // ONE read tool, not one per member. A knowledge base with eight members
  // produced eight near-identical "Read from X" tools competing inside a single
  // skill — the near-identical descriptions docs/adr/0039 §5 warns about,
  // reproduced one level down — and the model had to pick the right tool before
  // it could ask the right question. The corpus travels in the input instead,
  // where the model can read it straight off a citation.
  const readable = kb.corpusRefs
    .map((ref) => connections.get(ref))
    .filter((connection): connection is CorpusDescriptor => {
      // A member with no identity provider cannot serve a per-user read: the
      // read face has no service-credential mode by design (docs/adr/0040), so
      // listing it would offer an option that always fails.
      return Boolean(connection?.apiEnabled && connection.identityProviders?.length);
    });

  if (readable.length > 0) {
    tools.push(knowledgeBaseReadTool(kb, readable, exec("read")));
  }

  return tools;
}

/**
 * The ONE live read a knowledge base offers.
 *
 * Union to INVOKE over the members it can actually serve, then per member at
 * call time (docs/adr/0039 §4). Restricting it to a single member's roles would
 * make it uncallable for the rest; granting it the whole knowledge base's union
 * would offer it to callers who could read nothing through it.
 *
 * PARITY: `knowledgeBaseReadTool` in `engines/temporal/internal/catalog`.
 */
export function knowledgeBaseReadTool(
  kb: KnowledgeBaseDescriptor,
  readable: CorpusDescriptor[],
  exec: ToolDescriptor["knowledgeBaseExec"],
): ToolDescriptor {
  const names = readable
    .map((connection) => `${connection.id} (${connectionLabel(connection)})`)
    .join(", ");
  const roles = [...new Set(readable.flatMap((connection) => connection.allowedRoles))].sort();

  return {
    id: knowledgeBaseReadToolId(kb.id),
    name: `Read from ${knowledgeBaseLabel(kb)}`,
    description:
      `Read the full, current text of one document in ${knowledgeBaseLabel(kb)}. ` +
      "Use after searching, when a passage is not enough or looks out of date." +
      `\n\nInput: \`<corpus>/<id>\`, where <corpus> is one of: ${names}, and <id> is ` +
      "the resource id a search result cites. Reads LIVE and as the asking user, so it " +
      "can follow a reference out of this knowledge base into anything that person has " +
      "access to — and refuses anything they cannot see." +
      "\nOutput: The document as the source returns it now, with a citation.",
    allowedRoles: roles,
    hidden: true,
    knowledgeBaseExec: exec,
  };
}


/**
 * Snapshots the member data the search path needs.
 *
 * Taken at index time so a search runs over exactly the membership the planner
 * was offered, and so the executing side needs no second source of truth that
 * could disagree with the first.
 */
function execMembers(
  kb: KnowledgeBaseDescriptor,
  connections: ReadonlyMap<string, CorpusDescriptor>,
): KnowledgeBaseExecMember[] {
  const members: KnowledgeBaseExecMember[] = [];
  for (const ref of kb.corpusRefs) {
    const connection = connections.get(ref);
    if (!connection) continue; // dangling; the controller reports it in status
    members.push({
      id: connection.id,
      label: connectionLabel(connection),
      collection: connection.collection ?? "",
      allowedRoles: connection.allowedRoles,
      granularity: providerGranularity(connection.provider),
      identityProviders: connection.identityProviders,
    });
  }
  return members;
}

/**
 * The unit a provider authorizes at (docs/adr/0040).
 *
 * Slack authorizes a CHANNEL — membership is the access unit and there is no
 * per-message permission — so one probe settles every candidate from that
 * connection. Anything unrecognised is per RESOURCE: the finer unit is the safe
 * default, since assuming per-connection would let one allowed resource vouch
 * for every other candidate from that source.
 */
function providerGranularity(provider: string): "resource" | "connection" {
  return provider === "slack" ? "connection" : "resource";
}
