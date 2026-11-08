import * as k8s from "@kubernetes/client-node";

/** Phases the k8s watch API emits for a custom resource (ignores BOOKMARK/ERROR frames). */
export type WatchPhase = "ADDED" | "MODIFIED" | "DELETED";

export interface CrdWatcherOptions {
  group: string;
  version: string;
  namespace: string;
  plural: string;
}

/**
 * A single catalog change, as reported by a registry's `watch()` (Tool,
 * LocalTool, Skill, Agent). `upsert` carries the freshly-decoded descriptor
 * (ADDED and MODIFIED are handled identically -- both are just "this is the
 * current state, re-embed and re-upsert it"); `delete` carries only the CR's
 * name, since a DELETED event's `obj` is the CR's last known state, not
 * useful beyond the id.
 */
export type CrdChangeEvent<T> = { type: "upsert"; descriptor: T } | { type: "delete"; id: string };

/** Injectable signature so registries can fake watches in tests without a real KubeConfig. */
export type WatchCrdFn = (
  opts: CrdWatcherOptions,
  onEvent: (phase: WatchPhase, obj: unknown) => void,
  onError?: (err: unknown) => void,
) => { stop: () => void };

const RECONNECT_DELAY_MS = 2_000;

/**
 * Builds a {@link WatchCrdFn} bound to a real cluster connection. Wraps
 * `@kubernetes/client-node`'s `Watch` (an HTTP long-poll against the
 * apiserver) with an informer-style reconnect loop: the apiserver closes the
 * connection on its own watch timeout every few minutes even when nothing
 * changed, and `Watch`'s `done` callback fires once per disconnect (not per
 * event) — so a fresh watch must be started there, every time, not just on
 * error.
 *
 * This is what makes the Tool/LocalTool/Skill/Agent catalogs hot-reloadable
 * (docs/adr/0020): a CR created after startup is now seen as soon as the
 * apiserver delivers the ADDED event, no orchestrator restart required.
 */
export function makeCrdWatcher(kubeConfig: k8s.KubeConfig): WatchCrdFn {
  const watch = new k8s.Watch(kubeConfig);

  return ({ group, version, namespace, plural }, onEvent, onError) => {
    const path = `/apis/${group}/${version}/namespaces/${namespace}/${plural}`;
    let stopped = false;
    let abortController: AbortController | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (stopped) return;
      watch
        .watch(
          path,
          {},
          (phase, obj) => {
            if (phase === "ADDED" || phase === "MODIFIED" || phase === "DELETED") {
              onEvent(phase, obj);
            }
          },
          (err) => {
            // `err` is `Watch.SERVER_SIDE_CLOSE` on a clean apiserver-initiated
            // close (the common case, not a failure) -- only surface anything
            // else to the caller.
            if (err && err !== k8s.Watch.SERVER_SIDE_CLOSE) onError?.(err);
            reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
          },
        )
        .then((abort) => {
          abortController = abort;
        })
        .catch((err) => {
          onError?.(err);
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        });
    };

    connect();

    return {
      stop: () => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        abortController?.abort();
      },
    };
  };
}
