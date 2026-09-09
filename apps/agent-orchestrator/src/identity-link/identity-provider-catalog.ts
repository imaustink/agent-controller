import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { IdentityLinkPort } from "./gateway-client.js";

/**
 * Which of agent-orchestrator's fixed link-flow implementations backs a
 * provider (docs/adr/0027) -- mirrors
 * `controllers/core-controller/api/v1alpha1/identityprovider_types.go`'s
 * `IdentityProviderFlow`. A closed set: unlike envVar/label/crossEntryPoint,
 * this selects a concrete gateway implementation, not data an operator can
 * introduce purely by writing a CR.
 */
export type IdentityProviderFlow = "oauth" | "claude-cli-setup-token" | "claude-remote-login";

/**
 * Everything agent-orchestrator needs to resolve and inject one identity
 * provider's credential -- the runtime mirror of an `IdentityProvider` CR's
 * spec. This used to be a hardcoded TypeScript map
 * (`authorization-service.ts`'s old `IDENTITY_PROVIDERS`); now it is decoded
 * off a CR by {@link toIdentityProviderConfig} and looked up dynamically
 * through {@link IdentityProviderCatalog}, so adding a provider (beyond the
 * two Claude-specific flows) never requires an agent-orchestrator code change.
 */
export interface IdentityProviderConfig {
  envVar: string;
  label: string;
  flow: IdentityProviderFlow;
  crossEntryPoint: boolean;
}

/**
 * Read-only, synchronous lookup of the current provider catalog -- what
 * {@link AuthorizationService} and `graph.ts`'s identity-gate helpers consult
 * instead of a static map. Synchronous because every call site is deep inside
 * a per-request hot path that used to be a plain object index; the catalog is
 * kept current in the background by {@link InMemoryIdentityProviderCatalog}'s
 * `watch()`-fed upserts, never refreshed on demand.
 */
export interface IdentityProviderCatalog {
  get(provider: string): IdentityProviderConfig | undefined;
}

/**
 * Fallback catalog used only when a deployment (or a test) does not inject
 * one via `AuthorizationServiceDeps`/`AgentGraphDeps`' `identityProviderCatalog`.
 * Mirrors the three `IdentityProvider` CRs
 * `charts/community-components/templates/identityprovider-defaults.yaml`
 * ships by default, so a test double that never mentions identity providers
 * keeps working exactly as it did before this CRD existed, while a real
 * deployment is always driven by the injected, CRD-backed catalog. This is
 * NOT where a new provider (e.g. glyph) gets added -- that only ever happens
 * by creating an `IdentityProvider` CR, read through the injected catalog.
 */
const DEFAULT_IDENTITY_PROVIDERS: Record<string, IdentityProviderConfig> = {
  github: { envVar: "GITHUB_TOKEN", label: "GitHub", flow: "oauth", crossEntryPoint: false },
  claude: { envVar: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude", flow: "claude-cli-setup-token", crossEntryPoint: true },
  "claude-remote": {
    envVar: "CLAUDE_LOGIN_CREDENTIALS_JSON",
    label: "Claude Remote Control",
    flow: "claude-remote-login",
    crossEntryPoint: true,
  },
};

export const DEFAULT_IDENTITY_PROVIDER_CATALOG: IdentityProviderCatalog = {
  get: (provider) => DEFAULT_IDENTITY_PROVIDERS[provider],
};

/** Resolves the effective catalog for a deps bag that may or may not have injected one. */
export function resolveIdentityProviderCatalog(catalog: IdentityProviderCatalog | undefined): IdentityProviderCatalog {
  return catalog ?? DEFAULT_IDENTITY_PROVIDER_CATALOG;
}

/**
 * Resolves which gateway client backs a given identity provider (docs/adr/0027),
 * off the catalog's `flow` -- the single place that knows "claude-cli-setup-
 * token" routes to `claudeAuthGateway` and "claude-remote-login" routes to
 * `claudeRemoteGateway`, instead of the generic "oauth" `identityLinkGateway`.
 * Shared by {@link AuthorizationService} and `graph.ts`'s link-lifecycle call
 * sites so there is exactly one gateway-routing implementation, not two kept
 * in sync by inspection.
 */
export function resolveIdentityGateway(
  provider: string,
  catalog: IdentityProviderCatalog,
  deps: {
    identityLinkGateway?: IdentityLinkPort;
    claudeAuthGateway?: IdentityLinkPort;
    claudeRemoteGateway?: IdentityLinkPort;
  },
): IdentityLinkPort | undefined {
  const flow = catalog.get(provider)?.flow ?? "oauth";
  if (flow === "claude-cli-setup-token") return deps.claudeAuthGateway;
  if (flow === "claude-remote-login") return deps.claudeRemoteGateway;
  return deps.identityLinkGateway;
}

/** Shape of an `IdentityProvider` custom resource (`<group>/<version>`, kind
 * `IdentityProvider`) — mirrors
 * `controllers/core-controller/api/v1alpha1/identityprovider_types.go`'s
 * `IdentityProviderSpec`. */
export interface IdentityProviderCustomResource {
  metadata: { name: string };
  spec: {
    envVar: string;
    label: string;
    /** Absent on the wire only for a CR predating the field's default; treat as "oauth" (mirrors the CRD's `+kubebuilder:default=oauth`). */
    flow?: IdentityProviderFlow;
    crossEntryPoint?: boolean;
  };
}

/** Plural resource name used by the `IdentityProvider` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const IDENTITY_PROVIDER_PLURAL = "identityproviders";

function toIdentityProviderConfig(cr: IdentityProviderCustomResource): IdentityProviderConfig | undefined {
  const spec = cr.spec;
  if (!spec?.envVar || !spec?.label) return undefined;
  return {
    envVar: spec.envVar,
    label: spec.label,
    flow: spec.flow ?? "oauth",
    crossEntryPoint: spec.crossEntryPoint ?? false,
  };
}

/**
 * In-memory view of the `IdentityProvider` catalog, kept current by feeding
 * it a registry's `listAll()` result at startup and its `watch()` events
 * afterward (same ADR 0020 pattern as the Tool/Agent/Skill catalogs in
 * `index.ts` -- see that file for the wiring). A plain `Map` under a narrow
 * interface, not a `CrdXRegistry` itself: unlike Tool/Agent/Skill, nothing
 * here is RAG-retrieved or ever iterated by a caller, only looked up by name,
 * so there is no descriptor/store/query machinery to mirror.
 */
export class InMemoryIdentityProviderCatalog implements IdentityProviderCatalog {
  private readonly byName = new Map<string, IdentityProviderConfig>();

  constructor(initial: Array<{ id: string; config: IdentityProviderConfig }> = []) {
    for (const { id, config } of initial) this.byName.set(id, config);
  }

  get(provider: string): IdentityProviderConfig | undefined {
    return this.byName.get(provider);
  }

  upsert(id: string, config: IdentityProviderConfig): void {
    this.byName.set(id, config);
  }

  delete(id: string): void {
    this.byName.delete(id);
  }
}

/**
 * Discovers the identity-provider catalog from `IdentityProvider` custom
 * resources -- same `listAll()`/`watch()` shape as `CrdAgentRegistry`/
 * `CrdToolRegistry`, decoding to `{ id, config }` pairs instead of a
 * RAG-relevant descriptor.
 */
export class CrdIdentityProviderRegistry {
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
  ): CrdIdentityProviderRegistry {
    return new CrdIdentityProviderRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }

  async listAll(): Promise<Array<{ id: string; config: IdentityProviderConfig }>> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: IDENTITY_PROVIDER_PLURAL,
    });
    const providers: Array<{ id: string; config: IdentityProviderConfig }> = [];
    for (const item of response.items ?? []) {
      const cr = item as IdentityProviderCustomResource;
      const id = cr.metadata?.name;
      const config = toIdentityProviderConfig(cr);
      if (id && config) providers.push({ id, config });
    }
    return providers;
  }

  watch(
    onChange: (event: CrdChangeEvent<{ id: string; config: IdentityProviderConfig }>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void } {
    if (!this.watchFn) {
      throw new Error("CrdIdentityProviderRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    }
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: IDENTITY_PROVIDER_PLURAL },
      (phase, obj) => {
        const cr = obj as IdentityProviderCustomResource;
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          onChange({ type: "delete", id });
          return;
        }
        const config = toIdentityProviderConfig(cr);
        if (config) onChange({ type: "upsert", descriptor: { id, config } });
      },
      onError,
    );
  }
}
