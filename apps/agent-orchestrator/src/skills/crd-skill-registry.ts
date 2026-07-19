import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { SkillDescriptor, SkillRegistry } from "./types.js";

/** Shape of a `Skill` custom resource (`<group>/<version>`, kind `Skill`) — mirrors
 * `controllers/core-controller/api/v1alpha1/skill_types.go`'s `SkillSpec`. */
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

/** Plural resource name used by the `Skill` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const SKILL_PLURAL = "skills";

/**
 * Discovers the skill catalog from `Skill` custom resources (ADR 0010) —
 * supersedes the static, hand-authored `catalog.ts` array (ADR 0008).
 * Skills become configurable in-cluster without an image rebuild.
 * `listAll()` is a one-shot read used only for the initial catalog at
 * startup; `watch()` (ADR 0020) keeps it current afterward via a live k8s
 * watch, same shape as `CrdToolRegistry`.
 */
export class CrdSkillRegistry implements SkillRegistry {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly api: CustomObjectsApiLike,
    /** Absent in tests that only exercise `listAll()`; real instances always pass one via `fromKubeConfig`. */
    private readonly watchFn?: WatchCrdFn,
  ) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdSkillRegistry {
    return new CrdSkillRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
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

  watch(
    onChange: (event: CrdChangeEvent<SkillDescriptor>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void } {
    if (!this.watchFn) throw new Error("CrdSkillRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: SKILL_PLURAL },
      (phase, obj) => {
        const cr = obj as SkillCustomResource;
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          onChange({ type: "delete", id });
          return;
        }
        const descriptor = toSkillDescriptor(cr);
        if (descriptor) onChange({ type: "upsert", descriptor });
      },
      onError,
    );
  }
}

export function toSkillDescriptor(cr: SkillCustomResource): SkillDescriptor | undefined {
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
