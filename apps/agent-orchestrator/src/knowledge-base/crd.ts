import type { ConnectionDescriptor, KnowledgeBaseDescriptor } from "./types.js";

/** Plural resource names used by the CRDs (match `config/crd/bases`). */
export const CONNECTION_PLURAL = "connections";
export const KNOWLEDGE_BASE_PLURAL = "knowledgebases";

/**
 * Shape of a `Connection` custom resource — mirrors
 * `controllers/core-controller/api/v1alpha1/connection_types.go`.
 *
 * Only the catalog-relevant fields appear. `scope`, `secretEnv` and `sync`
 * belong to the connection-broker and the controller; the orchestrator never
 * dereferences a credential or widens a scope, so it does not read them.
 */
export interface ConnectionCustomResource {
  metadata: { name: string };
  spec: {
    provider: string;
    description: string;
    displayName?: string;
    allowedRoles: string[];
    identityProviders?: string[];
    api?: { enabled?: boolean };
  };
  status?: {
    collection?: string;
  };
}

/** Shape of a `KnowledgeBase` custom resource — mirrors `knowledgebase_types.go`. */
export interface KnowledgeBaseCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    displayName?: string;
    aliases?: string[];
    connectionRefs: string[];
    disclosePartialVisibility?: boolean;
  };
}

/**
 * Decodes a Connection CR.
 *
 * A connection whose status carries no collection — admitted but not yet
 * reconciled — decodes fine and is simply not searchable until the controller
 * assigns one. `visibleConnections` treats that as a source the answer is
 * missing rather than as an error.
 */
export function toConnectionDescriptor(
  cr: ConnectionCustomResource,
): ConnectionDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.provider || !spec.description || !spec.allowedRoles?.length) {
    return undefined;
  }

  return {
    id: name,
    provider: spec.provider,
    displayName: spec.displayName,
    description: spec.description,
    allowedRoles: spec.allowedRoles,
    collection: cr.status?.collection,
    apiEnabled: spec.api?.enabled === true,
    identityProviders: spec.identityProviders ?? [],
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
  if (!name || !spec?.description || !spec.connectionRefs?.length) return undefined;

  return {
    id: name,
    displayName: spec.displayName,
    description: spec.description,
    aliases: spec.aliases ?? [],
    connectionRefs: spec.connectionRefs,
    disclosePartialVisibility: spec.disclosePartialVisibility !== false,
  };
}
