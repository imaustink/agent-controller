import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";

/** Shape of an `IntegrationRoute` custom resource (`<group>/<version>`, kind `IntegrationRoute`) —
 * mirrors `controllers/core-controller/api/v1alpha1/integrationroute_types.go`'s `IntegrationRouteSpec`. */
export interface IntegrationRouteCustomResource {
  metadata: { name: string };
  spec: {
    match: {
      source: string;
      event: string;
      /** Absent matches any action for this source/event pair. */
      action?: string;
    };
    /** Exactly one of skillRef/agentRef/toolRef is set (enforced by the CRD's CEL rule). */
    skillRef?: string;
    agentRef?: string;
    toolRef?: string;
    promptTemplate: string;
  };
}

/** A resolved route, decoded from an `IntegrationRoute` CR. */
export interface IntegrationRoute {
  id: string;
  source: string;
  event: string;
  action?: string;
  skillRef?: string;
  agentRef?: string;
  toolRef?: string;
  promptTemplate: string;
}

/** Plural resource name used by the `IntegrationRoute` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const INTEGRATION_ROUTE_PLURAL = "integrationroutes";

/**
 * Discovers declarative event→skill/agent/tool routing from `IntegrationRoute`
 * custom resources (docs/adr — deterministic dispatch for triggers whose
 * intent is already unambiguous, e.g. a GitHub issue being assigned to the
 * bot), rather than relying on RAG skill retrieval to infer intent from free
 * text. `listAll()` is a one-shot read used only for the initial route table
 * at startup; `watch()` (same pattern as `CrdSkillRegistry`/`CrdToolRegistry`,
 * ADR 0020) keeps it current afterward via a live k8s watch.
 */
export class CrdIntegrationRouteRegistry {
  private routes = new Map<string, IntegrationRoute>();

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
  ): CrdIntegrationRouteRegistry {
    return new CrdIntegrationRouteRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }

  async listAll(): Promise<IntegrationRoute[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: INTEGRATION_ROUTE_PLURAL,
    });
    this.routes.clear();
    for (const item of response.items ?? []) {
      const route = toIntegrationRoute(item as IntegrationRouteCustomResource);
      if (route) this.routes.set(route.id, route);
    }
    return [...this.routes.values()];
  }

  watch(onError?: (err: unknown) => void): { stop: () => void } {
    if (!this.watchFn) {
      throw new Error("CrdIntegrationRouteRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    }
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: INTEGRATION_ROUTE_PLURAL },
      (phase, obj) => {
        const cr = obj as IntegrationRouteCustomResource;
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          this.routes.delete(id);
          return;
        }
        const route = toIntegrationRoute(cr);
        if (route) this.routes.set(route.id, route);
      },
      onError,
    );
  }

  /**
   * Finds the route matching a given event, if any. An exact match on
   * `action` is preferred over a route whose `action` is absent (wildcard
   * for that source/event); ties beyond that resolve to whichever route was
   * indexed last. Exact-match only, deliberately — this CRD is a small,
   * declarative table (docs/integrations-gateway.md non-goal: no rules
   * engine), not a general pattern matcher.
   */
  match(source: string, event: string, action?: string): IntegrationRoute | undefined {
    let wildcardMatch: IntegrationRoute | undefined;
    for (const route of this.routes.values()) {
      if (route.source !== source || route.event !== event) continue;
      if (route.action && route.action === action) return route;
      if (!route.action) wildcardMatch = route;
    }
    return wildcardMatch;
  }
}

function toIntegrationRoute(cr: IntegrationRouteCustomResource): IntegrationRoute | undefined {
  const id = cr.metadata?.name;
  const spec = cr.spec;
  if (!id || !spec?.match?.source || !spec?.match?.event || !spec?.promptTemplate) return undefined;

  return {
    id,
    source: spec.match.source,
    event: spec.match.event,
    action: spec.match.action,
    skillRef: spec.skillRef,
    agentRef: spec.agentRef,
    toolRef: spec.toolRef,
    promptTemplate: spec.promptTemplate,
  };
}

/**
 * Renders a route's `promptTemplate` by substituting `{{field}}` placeholders
 * with values from the event's fields. No templating library — this is
 * deliberately a flat string-replace, not a general-purpose engine, since the
 * substitution set (owner, repo, issueNumber, title, body, senderLogin,
 * assigneeLogin, ...) is small and adapter-defined. Unmatched placeholders
 * are left verbatim (fail visibly rather than silently swallow a typo'd
 * field name from an operator-authored template).
 */
export function renderPromptTemplate(template: string, fields: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, field: string) => {
    const value = fields[field];
    return value === undefined ? match : String(value);
  });
}
