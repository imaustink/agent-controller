import type { CorpusDescriptor, KnowledgeBaseDescriptor } from "./types.js";

/** Plural resource names used by the CRDs (match `config/crd/bases`). */
export const CORPUS_PLURAL = "corpora";
export const KNOWLEDGE_BASE_PLURAL = "knowledgebases";

/**
 * Shape of a `Corpus` custom resource — mirrors
 * `controllers/core-controller/api/v1alpha1/corpus_types.go`.
 *
 * Only the catalog-relevant fields appear. `scope` and `sync` belong to the
 * connection-broker and the controller; the orchestrator never dereferences a
 * credential or widens a scope, so it does not read them — nor does it read the
 * Connection at all.
 */
export interface CorpusCustomResource {
  metadata: { name: string };
  spec: {
    connectionRef: string;
    description: string;
    displayName?: string;
    allowedRoles: string[];
    api?: { enabled?: boolean };
  };
  /**
   * `provider` and `identityProviders` live on the Connection and are copied
   * here by the controller (docs/adr/0043 §1), so this engine reads ONE kind to
   * build its catalog instead of joining across two.
   */
  status?: {
    collection?: string;
    provider?: string;
    identityProviders?: string[];
  };
}

/** Shape of a `KnowledgeBase` custom resource — mirrors `knowledgebase_types.go`. */
export interface KnowledgeBaseCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    displayName?: string;
    aliases?: string[];
    corpusRefs: string[];
    disclosePartialVisibility?: boolean;
  };
}

/**
 * Decodes a Corpus CR.
 *
 * A Corpus whose status carries no collection — admitted but not yet
 * reconciled — decodes fine and is simply not searchable until the controller
 * assigns one. `visibleCorpora` treats that as a source the answer is missing
 * rather than as an error.
 *
 * A Corpus whose status carries no PROVIDER has not resolved its Connection
 * yet, or has stopped resolving it. Same treatment, for the same reason: it is
 * an ordinary state, and a member whose provider nobody knows contributes
 * nothing rather than contributing wrongly.
 */
export function toCorpusDescriptor(
  cr: CorpusCustomResource,
): CorpusDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.description || !spec.allowedRoles?.length) {
    return undefined;
  }

  return {
    id: name,
    provider: cr.status?.provider ?? "",
    displayName: spec.displayName,
    description: spec.description,
    allowedRoles: spec.allowedRoles,
    collection: cr.status?.collection,
    apiEnabled: spec.api?.enabled === true,
    identityProviders: cr.status?.identityProviders ?? [],
  };
}

/**
 * Decodes a KnowledgeBase CR.
 *
 * `disclosePartialVisibility` defaults TRUE when absent. The CRD defaults it
 * too, so an absent value here means an object predating the field rather than
 * an operator choosing silence — and silence is the worse default, because a
 * confidently wrong "there's nothing about that" is the failure a knowledge
 * base exists to prevent (docs/adr/0039 §4).
 */
export function toKnowledgeBaseDescriptor(
  cr: KnowledgeBaseCustomResource,
): KnowledgeBaseDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.description || !spec.corpusRefs?.length) return undefined;

  return {
    id: name,
    displayName: spec.displayName,
    description: spec.description,
    aliases: spec.aliases ?? [],
    corpusRefs: spec.corpusRefs,
    disclosePartialVisibility: spec.disclosePartialVisibility !== false,
  };
}
