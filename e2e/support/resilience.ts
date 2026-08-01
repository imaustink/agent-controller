import { kubectl, kubectlJson, waitFor, NAMESPACE } from "./k8s.js";

/**
 * Helpers for the resilience spec: pacing the stub agent's turn, disrupting
 * infrastructure mid-turn, and reading what the orchestrator said about it.
 *
 * Kept out of k8s.ts because these DISRUPT the cluster (deleting the NATS pod,
 * rolling the orchestrator) rather than only observing it. Anything importing
 * this is asserting on recovery, and should say so.
 */

/** Pacing knobs on the stub Agent CR — see apps/stub-agent/src/pacing.ts. */
export interface StubPacing {
  narrateForMs?: number;
  narrateEveryMs?: number;
  silentForMs?: number;
  /**
   * How often the runtime RE-OFFERS a concluding reply nobody has acked yet
   * (`AGENT_REPLY_ACK_RETRY_MS`, packages/agent-runtime). Production default is
   * 10s, which is a sensible cadence for a real run and too slow for a spec that
   * has to observe a recovery inside the gateway's poll budget.
   *
   * Only worth setting on the resumability spec: after a rollout the held reply is
   * collected by the NEXT turn re-attaching, and if the re-offer lands late the
   * gateway gives up on its own poll first and posts a failure instead of the
   * reply. Turning this down makes the recovery prompt rather than making the test
   * wait longer -- which it cannot do, since waiting past the gateway's budget
   * means the answer never arrives at all.
   */
  replyAckRetryMs?: number;
}

/**
 * Rewrites the stub Agent CR's `env` so the NEXT run paces itself.
 *
 * Patches the CR rather than the Job: the orchestrator reads the Agent CR when
 * it builds each AgentRun, so this takes effect on the next launch with no
 * redeploy. A JSON merge patch replaces the whole `env` array, which is what we
 * want — leftover pacing from a previous test is exactly the cross-test
 * contamination that would make these specs lie.
 */
export async function paceStubAgent(pacing: StubPacing): Promise<void> {
  const env = [
    { name: "STUB_NARRATE_FOR_MS", value: String(pacing.narrateForMs ?? 0) },
    { name: "STUB_NARRATE_EVERY_MS", value: String(pacing.narrateEveryMs ?? 2000) },
    { name: "STUB_SILENT_FOR_MS", value: String(pacing.silentForMs ?? 0) },
    // Omitted unless asked for, so every other spec keeps the production cadence
    // and this stays a deliberate, local choice rather than a suite-wide default.
    ...(pacing.replyAckRetryMs === undefined
      ? []
      : [{ name: "AGENT_REPLY_ACK_RETRY_MS", value: String(pacing.replyAckRetryMs) }]),
  ];
  await kubectl([
    "patch",
    "agent",
    "stub-agent",
    "--type",
    "merge",
    "-p",
    JSON.stringify({ spec: { env } }),
  ]);
}

/** Restores the stub to replying immediately, so later specs are unaffected. */
export async function resetStubPacing(): Promise<void> {
  await paceStubAgent({});
}

/**
 * The NATS SERVER pod (a StatefulSet of one here).
 *
 * Selected on `app.kubernetes.io/component=nats`, NOT
 * `app.kubernetes.io/name=nats`: the latter also matches `nats-box`, a utility
 * pod in the same chart. Deleting that instead would leave NATS itself running
 * and the spec would pass while testing nothing at all.
 */
const NATS_SERVER_SELECTOR = "app.kubernetes.io/component=nats";

export async function natsPodName(): Promise<string> {
  const list = await kubectlJson<{ items: { metadata: { name: string } }[] }>([
    "get",
    "pods",
    "-l",
    NATS_SERVER_SELECTOR,
  ]);
  if (list.items.length !== 1) {
    // Fail rather than guess: picking the wrong pod here silently defeats the
    // only spec that uses this.
    throw new Error(
      `e2e: expected exactly one NATS server pod matching ${NATS_SERVER_SELECTOR}, found ${list.items.length}` +
        ` (${list.items.map((i) => i.metadata.name).join(", ") || "none"}) -- is the stack up?`,
    );
  }
  return list.items[0]!.metadata.name;
}

/**
 * Deletes the NATS pod and waits for its replacement to be Ready.
 *
 * This is the outage the orchestrator has to survive. Under nats.js defaults it
 * cannot: 10 reconnect attempts 2s apart, then the connection closes for good
 * with nothing re-establishing it, taking every in-flight subscription with it.
 */
export async function bounceNats(): Promise<{ oldPod: string; newPodReadyMs: number }> {
  const oldPod = await natsPodName();
  const startedAt = Date.now();
  await kubectl(["delete", "pod", oldPod, "--wait=false"]);

  await waitFor(
    "the NATS pod to be replaced and Ready",
    async () => {
      const list = await kubectlJson<{
        items: { metadata: { name: string; deletionTimestamp?: string }; status?: { conditions?: { type: string; status: string }[] } }[];
      }>(["get", "pods", "-l", NATS_SERVER_SELECTOR]);
      const ready = list.items.find(
        (p) =>
          !p.metadata.deletionTimestamp &&
          p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      );
      return ready ? ready.metadata.name : undefined;
    },
    { timeoutMs: 180_000 },
  );
  return { oldPod, newPodReadyMs: Date.now() - startedAt };
}

const REDIS_SELECTOR = "app.kubernetes.io/name=agent-orchestrator-redis";

/**
 * Deletes the Redis pod and waits for its replacement to be Ready.
 *
 * This is the outage that motivated docs/adr/0034, and it is not hypothetical:
 * this pod really did terminate in production and take every stored credential
 * with it, because it runs with `--save "" --appendonly no` on an emptyDir. A
 * user who had linked months earlier was asked to authorize again, and the
 * authorization pre-flight looked entirely correct while it happened -- it
 * resolved the right principal and found nothing there.
 *
 * Deliberately NOT paired with a persistence fix: Redis stays ephemeral, because
 * the point is that credentials no longer live in it. A spec using this asserts
 * exactly that.
 */
export async function bounceRedis(): Promise<{ oldPod: string; newPodReadyMs: number }> {
  const list = await kubectlJson<{ items: { metadata: { name: string } }[] }>(["get", "pods", "-l", REDIS_SELECTOR]);
  if (list.items.length !== 1) {
    throw new Error(
      `e2e: expected exactly one Redis pod matching ${REDIS_SELECTOR}, found ${list.items.length}` +
        ` (${list.items.map((i) => i.metadata.name).join(", ") || "none"}) -- is the stack up?`,
    );
  }
  const oldPod = list.items[0]!.metadata.name;
  const startedAt = Date.now();
  await kubectl(["delete", "pod", oldPod, "--wait=false"]);

  await waitFor(
    "the Redis pod to be replaced and Ready",
    async () => {
      const current = await kubectlJson<{
        items: {
          metadata: { name: string; deletionTimestamp?: string };
          status?: { conditions?: { type: string; status: string }[] };
        }[];
      }>(["get", "pods", "-l", REDIS_SELECTOR]);
      const ready = current.items.find(
        (p) =>
          !p.metadata.deletionTimestamp &&
          p.metadata.name !== oldPod &&
          p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      );
      return ready ? ready.metadata.name : undefined;
    },
    { timeoutMs: 180_000 },
  );
  return { oldPod, newPodReadyMs: Date.now() - startedAt };
}

/** Rolls the orchestrator Deployment and waits for the rollout to complete. */
export async function rollOrchestrator(): Promise<void> {
  await kubectl(["rollout", "restart", "deploy/agent-orchestrator"]);
  // `rollout status` blocks until the new ReplicaSet is available; the old pod
  // receives SIGTERM as soon as the restart is recorded, which is the moment
  // that matters for an in-flight turn.
  await kubectl(["rollout", "status", "deploy/agent-orchestrator", "--timeout=300s"]);
}

/**
 * NOTE: there is deliberately no `orchestratorLogs()` helper here.
 *
 * A turn's error text is never logged -- `state.error` is returned over HTTP
 * (agent-orchestrator/src/server.ts) and the gateway renders it into the issue
 * comment. So a spec asserting on orchestrator logs for it can only ever pass
 * vacuously in the negative and fail in the positive, which is exactly what an
 * earlier version of resilience.e2e.ts did. Assert on the comment body.
 */

export { NAMESPACE };
