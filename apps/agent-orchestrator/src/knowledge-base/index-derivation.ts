import type { SkillAccess } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import { deriveKnowledgeBaseSkill } from "./derive.js";
import type { KnowledgeBaseExecMember, KnowledgeBaseExecSpec } from "./exec.js";
import {
  corpusGetToolId,
  connectionLabel,
  knowledgeBaseLabel,
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
  const exec = (operation: "search" | "fetch"): KnowledgeBaseExecSpec => ({
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

  for (const ref of kb.corpusRefs) {
    const connection = connections.get(ref);
    if (!connection?.apiEnabled) continue;
    // A Corpus with no identity provider cannot serve a per-user read, and the
    // GET face has no service-credential mode by design (docs/adr/0040):
    // reading live on the ingestion credential would answer a different
    // question, permissively. So no tool, rather than one that can only fail
    // after the model has committed to using it.
    if (!connection.identityProviders?.length) continue;
    tools.push(connectionGetTool(connection));
  }

  return tools;
}

/**
 * A Corpus's scope-enforced GET face (docs/adr/0038 §5), carrying that
 * connection's OWN roles rather than the knowledge base's union — it is one
 * source's capability, not the composition's. Granting it the union would let a
 * caller read a source they hold no role for.
 */
export function connectionGetTool(connection: CorpusDescriptor): ToolDescriptor {
  const label = connectionLabel(connection);
  return {
    id: corpusGetToolId(connection.id),
    name: `Read from ${label}`,
    description:
      `Read the current state of a resource in ${label} (${connection.provider}). ` +
      `${connection.description}` +
      "\n\nInput: The id of a resource in this corpus — the same id a search " +
      "result cites. Ids outside this corpus's scope are refused, and the read " +
      "runs as the asking user, so anything they cannot see is refused too." +
      "\nOutput: The resource as the source returns it now, for the calling user.",
    allowedRoles: connection.allowedRoles,
    hidden: true,
    corpusGetExec: {
      corpusId: connection.id,
      label,
      identityProviders: connection.identityProviders,
    },
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
