import * as k8s from "@kubernetes/client-node";

/*
 * DUPLICATED from orchestrator/apps/connection-broker/src/k8s/crd-watcher.ts.
 *
 * Copied rather than shared for the same reason connection-broker copied it:
 * the broker is a deliberately separate Deployment (ADR 0045 §3) — the MCP wire
 * protocol and its sessions stay out of the pod holding the agent loop — and
 * there is no package today both could depend on without one pulling in the
 * other's dependency tree. If a third consumer appears, this is the point to
 * extract a package instead.
 *
 * Keep the copies in step: the reconnect behaviour below is not incidental.
 */

/** Phases the k8s watch API emits for a custom resource (ignores BOOKMARK/ERROR frames). */
export type WatchPhase = "ADDED" | "MODIFIED" | "DELETED";

export interface CrdWatcherOptions {
  group: string;
  version: string;
  namespace: string;
  plural: string;
}

/** Injectable signature so registries can fake watches in tests without a real KubeConfig. */
export type WatchCrdFn = (
  opts: CrdWatcherOptions,
  onEvent: (phase: WatchPhase, obj: unknown) => void,
  onError?: (err: unknown) => void,
) => { stop: () => void };

const RECONNECT_DELAY_MS = 2_000;

/**
 * Builds a {@link WatchCrdFn} bound to a real cluster connection. Wraps
 * `@kubernetes/client-node`'s `Watch` (an HTTP long-poll against the apiserver)
 * with an informer-style reconnect loop: the apiserver closes the connection on
 * its own watch timeout every few minutes even when nothing changed, and
 * `Watch`'s `done` callback fires once per disconnect (not per event) — so a
 * fresh watch must be started there, every time, not just on error.
 *
 * This is what makes the MCPServer catalog hot-reloadable (ADR 0020 posture): a
 * server created after startup is discovered as soon as the apiserver delivers
 * the ADDED event, no broker restart required.
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
