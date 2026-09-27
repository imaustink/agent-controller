import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import {
  CORPUS_PLURAL,
  KNOWLEDGE_BASE_PLURAL,
  toCorpusDescriptor,
  toKnowledgeBaseDescriptor,
  type CorpusCustomResource,
  type KnowledgeBaseCustomResource,
} from "./crd.js";
import type { CorpusDescriptor, KnowledgeBaseDescriptor } from "./types.js";

/**
 * Discovers Corpora and KnowledgeBases from custom resources, the same
 * shape `CrdSkillRegistry` uses: `listAll()` seeds the catalog at startup,
 * `watch()` (ADR 0020) keeps it current afterwards.
 *
 * Two registries rather than one because they are watched independently and a
 * change to either re-derives the knowledge-base skills — see
 * `deriveKnowledgeBaseSkill` for why both feed one derivation.
 *
 * PARITY: `RunWatch` in `engines/temporal/internal/catalog/watch.go`.
 */
class CrdRegistry<CR, D> {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly plural: string,
    private readonly decode: (cr: CR) => D | undefined,
    private readonly api: CustomObjectsApiLike,
    /** Absent in tests that only exercise `listAll()`. */
    private readonly watchFn?: WatchCrdFn,
  ) {}

  async listAll(): Promise<D[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: this.plural,
    });
    const descriptors: D[] = [];
    for (const item of response.items ?? []) {
      const descriptor = this.decode(item as CR);
      if (descriptor) descriptors.push(descriptor);
    }
    return descriptors;
  }

  watch(
    onChange: (event: CrdChangeEvent<D>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void } {
    if (!this.watchFn) {
      throw new Error(`${this.plural} registry watch() requires a watchFn (construct via fromKubeConfig)`);
    }
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: this.plural },
      (phase, obj) => {
        const cr = obj as { metadata?: { name?: string } };
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          onChange({ type: "delete", id });
          return;
        }
        const descriptor = this.decode(obj as CR);
        if (descriptor) onChange({ type: "upsert", descriptor });
      },
      onError,
    );
  }
}

export class CrdConnectionRegistry extends CrdRegistry<
  CorpusCustomResource,
  CorpusDescriptor
> {
  constructor(
    namespace: string,
    group: string,
    version: string,
    api: CustomObjectsApiLike,
    watchFn?: WatchCrdFn,
  ) {
    super(namespace, group, version, CORPUS_PLURAL, toCorpusDescriptor, api, watchFn);
  }

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdConnectionRegistry {
    return new CrdConnectionRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }
}

export class CrdKnowledgeBaseRegistry extends CrdRegistry<
  KnowledgeBaseCustomResource,
  KnowledgeBaseDescriptor
> {
  constructor(
    namespace: string,
    group: string,
    version: string,
    api: CustomObjectsApiLike,
    watchFn?: WatchCrdFn,
  ) {
    super(namespace, group, version, KNOWLEDGE_BASE_PLURAL, toKnowledgeBaseDescriptor, api, watchFn);
  }

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdKnowledgeBaseRegistry {
    return new CrdKnowledgeBaseRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }
}
