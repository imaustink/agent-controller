import * as k8s from "@kubernetes/client-node";
import {
  compileTrigger,
  selectTrigger,
  type CompiledTrigger,
  type Envelope,
  type EventTriggerResource,
  type SelectResult,
} from "@controller-agent/event-triggers";
import { makeCrdWatcher, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";

/** Plural resource name used by the `EventTrigger` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const EVENT_TRIGGER_PLURAL = "eventtriggers";

/**
 * What `/invoke` needs from a trigger table: pick the single winning trigger
 * for an envelope (docs/event-triggers.md §4). Kept as a port so the server
 * can be tested without a cluster.
 */
export interface EventTriggerSelector {
  select(envelope: Envelope, options?: { callerSessionId?: string }): SelectResult;
}

/**
 * Whether core-controller has marked the trigger `Ready=True`. No status (not
 * reconciled yet), `False` or `Unknown` all mean "never matches" -- fail
 * closed, so a trigger whose target the controller could not resolve is never
 * dispatched on the strength of our own compile alone.
 */
export function isControllerReady(resource: EventTriggerResource): boolean {
  return (resource.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `/invoke`'s `event` field as a normalized envelope
 * (docs/event-triggers.md §2), returning the envelope or a reason it is
 * malformed (the caller answers 400).
 *
 * Strict on what selection and the session id depend on (`source`, `kind`,
 * `id`, `time`, and the types of `headers`/`sender`/`repository`), because a
 * loosely-typed envelope would make CEL see a different shape here than the
 * Temporal engine or the gateway produced -- and a predicate like
 * `headers["x-github-event"] == "pull_request"` silently evaluating over a
 * non-map is exactly the cross-engine drift the contract forbids. `body` is
 * any JSON; an absent one is `{}` (what a cron source with no payload sends).
 */
export function parseEnvelope(raw: unknown): Envelope | { error: string } {
  if (!isPlainObject(raw)) return { error: "event must be an object" };
  const { source, kind, id, time, headers, body, sender, repository } = raw;
  if (typeof source !== "string" || source === "") return { error: "event.source must be a non-empty string" };
  if (kind !== "webhook" && kind !== "cron") return { error: 'event.kind must be "webhook" or "cron"' };
  if (typeof id !== "string" || id === "") return { error: "event.id must be a non-empty string" };
  if (typeof time !== "string" || time === "") return { error: "event.time must be a non-empty string" };
  if (headers !== undefined && !isPlainObject(headers)) return { error: "event.headers must be an object" };
  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string") return { error: `event.headers[${JSON.stringify(name)}] must be a string` };
    normalizedHeaders[name] = value;
  }
  if (sender !== undefined && !isPlainObject(sender)) return { error: "event.sender must be an object" };
  if (repository !== undefined && typeof repository !== "string") return { error: "event.repository must be a string" };
  return {
    source,
    kind,
    id,
    time,
    headers: normalizedHeaders,
    body: (body === undefined ? {} : body) as Envelope["body"],
    sender: (sender ?? {}) as Envelope["sender"],
    repository: repository ?? "",
  };
}

/**
 * Discovers event-driven dispatch from `EventTrigger` custom resources
 * (ADR 0048, docs/event-triggers.md). Replaces the old `IntegrationRoute`
 * table: matching is CEL over the normalized envelope rather than an
 * exact-equality `source/event/action/labelName` lookup, so no event shape is
 * special-cased here.
 *
 * Every CR is compiled once, on arrival, with the shared
 * `@controller-agent/event-triggers` package — the SAME compile the
 * core-controller runs for the `Ready` condition and the Temporal engine runs
 * in Go (cross-engine parity is pinned by the package's CEL fixture suite).
 * A trigger whose CEL or target does not compile is kept in the table but is
 * not ready, and `selectTrigger` never matches it (fail closed): a typo'd
 * predicate must not silently widen to "match everything".
 *
 * `listAll()` is a one-shot read for the initial table at startup; `watch()`
 * (same pattern as `CrdSkillRegistry`/`CrdToolRegistry`, ADR 0020) keeps it
 * current via a live k8s watch.
 */
export class CrdEventTriggerRegistry implements EventTriggerSelector {
  private triggers = new Map<string, CompiledTrigger>();

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
  ): CrdEventTriggerRegistry {
    return new CrdEventTriggerRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }

  async listAll(): Promise<CompiledTrigger[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: EVENT_TRIGGER_PLURAL,
    });
    this.triggers.clear();
    for (const item of response.items ?? []) this.upsert(item as EventTriggerResource);
    return [...this.triggers.values()];
  }

  watch(onError?: (err: unknown) => void): { stop: () => void } {
    if (!this.watchFn) {
      throw new Error("CrdEventTriggerRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    }
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: EVENT_TRIGGER_PLURAL },
      (phase, obj) => {
        const cr = obj as EventTriggerResource;
        const name = cr?.metadata?.name;
        if (!name) return;
        if (phase === "DELETED") {
          this.triggers.delete(name);
          return;
        }
        this.upsert(cr);
      },
      onError,
    );
  }

  /** Every compiled trigger, ready or not (diagnostics/tests). */
  list(): CompiledTrigger[] {
    return [...this.triggers.values()];
  }

  /**
   * The single winning trigger for `envelope` (docs/event-triggers.md §4):
   * `ignored` when nothing matches, `failed` when the winner's params or
   * templates cannot be resolved, `matched` otherwise. Never throws.
   */
  select(envelope: Envelope, options: { callerSessionId?: string } = {}): SelectResult {
    // Two independent readiness gates, both required: our own compile
    // (`compiled.ready`, enforced inside selectTrigger) AND the controller's
    // `Ready=True` condition, which additionally means the sourceRef/target
    // refs resolve. Evaluated here, at selection time, off the CR as last seen
    // -- a status update is just a MODIFIED watch event, so readiness tracks
    // it with no extra bookkeeping. Parity with the Temporal engine, which
    // gates on the same condition.
    const offered = [...this.triggers.values()].filter((t) => isControllerReady(t.resource));
    return selectTrigger(offered, envelope, {
      ...(options.callerSessionId ? { callerSessionId: options.callerSessionId } : {}),
      // A runtime evaluation error is a NON-match (contract §3), but a silent
      // one would make a broken predicate indistinguishable from an event that
      // simply didn't qualify -- so name the trigger in the log.
      onMatchError: (trigger, error) =>
        console.error(`[event-trigger] ${trigger}: match.cel did not evaluate (treated as no match): ${error}`),
    });
  }

  private upsert(cr: EventTriggerResource): void {
    if (!cr?.metadata?.name) return;
    const compiled = compileTrigger(cr);
    if (!compiled.ready) {
      console.error(`[event-trigger] ${compiled.name} is not ready and will never match: ${compiled.error ?? "unknown error"}`);
    }
    this.triggers.set(compiled.name, compiled);
  }
}
