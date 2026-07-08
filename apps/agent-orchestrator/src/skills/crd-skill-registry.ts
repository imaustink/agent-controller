import * as k8s from "@kubernetes/client-node";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { SkillDescriptor, SkillRegistry } from "./types.js";

/** Shape of a `Skill` custom resource (`<group>/<version>`, kind `Skill`) — mirrors
 * `controllers/tool-controller/api/v1alpha1/skill_types.go`'s `SkillSpec`. */
export interface SkillCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    /** Optional plain-language input contract — descriptive only, folded into the RAG text. */
    input?: string;
    /** Optional plain-language output description — descriptive only, folded into the RAG text. */
    output?: string;
    markdown: string;
    /**
     * May be absent/empty for respond-only skills. A Skill CR carries no
     * allowedRoles (docs/adr/0011) — its audience is derived from these
     * tools' allowedRoles at index time (see derive-access.ts).
     */
    toolRefs?: string[];
  };
}

/** Plural resource name used by the `Skill` CRD (matches `config/crd/bases` in controllers/tool-controller). */
export const SKILL_PLURAL = "skills";

/**
 * Discovers the skill catalog from `Skill` custom resources (ADR 0010) —
 * supersedes the static, hand-authored `catalog.ts` array (ADR 0008).
 * Skills become configurable in-cluster without an image rebuild, at the
 * cost of the same one-shot-at-startup limitation `CrdToolRegistry` has (no
 * live watch loop yet).
 */
export class CrdSkillRegistry implements SkillRegistry {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly api: CustomObjectsApiLike,
  ) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdSkillRegistry {
    return new CrdSkillRegistry(namespace, group, version, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async listAll(): Promise<SkillDescriptor[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: SKILL_PLURAL,
    });
    const skills: SkillDescriptor[] = [];
    for (const item of response.items ?? []) {
      const descriptor = toSkillDescriptor(item as SkillCustomResource);
      if (descriptor) skills.push(descriptor);
    }
    return skills;
  }
}

function toSkillDescriptor(cr: SkillCustomResource): SkillDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  // toolRefs may legitimately be empty (respond-only skill, ADR 0011); only
  // name and markdown are structurally required.
  if (!name || !spec?.markdown) return undefined;

  // Fold the optional input/output contract into the embedded text, same
  // composition CrdToolRegistry uses for tools (richer RAG matching without
  // any SkillDescriptor/store interface change).
  let description = spec.description;
  if (spec.input) description += `\n\nInput: ${spec.input}`;
  if (spec.output) description += `\nOutput: ${spec.output}`;

  return {
    id: name,
    name,
    description,
    markdown: spec.markdown,
    toolIds: spec.toolRefs ?? [],
  };
}
