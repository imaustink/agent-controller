import { describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectlJson, NAMESPACE, waitFor } from "../support/k8s.js";
import { grantsFromMarkers, missingFrom, type Grant } from "../support/rbac.js";

/**
 * The last link of the RBAC chain `rbac-parity.e2e.ts` checks: the ClusterRole
 * that is actually installed, and the controller that has to start under it.
 *
 * Separate file because this one needs the cluster and that one must not. The
 * chart being right does not make the cluster right -- a release that predates
 * the fix keeps serving the old ClusterRole until someone upgrades it, and the
 * resulting crashloop is indistinguishable from the source-level bug at the
 * point where it hurts.
 */
requireMinikubeContext();

const markers = grantsFromMarkers();

describe("core-controller RBAC as deployed", () => {
  it("the installed ClusterRole grants everything the markers declare", async () => {
    const role = await kubectlJson<{
      rules?: { apiGroups?: string[]; resources?: string[]; verbs?: string[] }[];
    }>(["get", "clusterrole", "core-controller"]);

    const installed = new Set<Grant>();
    for (const rule of role.rules ?? []) {
      for (const g of rule.apiGroups ?? []) {
        for (const r of rule.resources ?? []) {
          for (const v of rule.verbs ?? []) installed.add(`${g || "core"}/${r}:${v}`);
        }
      }
    }

    const missing = missingFrom(markers, installed);
    expect(
      missing,
      [
        `The installed ClusterRole is missing ${missing.length} grant(s) the controller's markers declare:`,
        ...missing.map((g) => `  - ${g}`),
        "",
        "If `rbac-parity.e2e.ts` passes, the chart is right and the RELEASE is stale:",
        "redeploy with ./e2e/scripts/up.sh. Helm does upgrade ClusterRoles (unlike",
        "crds/), so this should not survive one.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the controller reaches Available, which a missing grant prevents", async () => {
    // The symptom, asserted directly. A manager whose caches cannot sync exits
    // before it ever serves /readyz, so this is the shortest path from "RBAC is
    // wrong" to a red test -- and it also catches the same crashloop arriving
    // from somewhere other than RBAC (a missing CRD, a bad image).
    await waitFor(
      "core-controller deployment is Available",
      async () => {
        const deploy = await kubectlJson<{
          status?: { conditions?: { type: string; status: string }[] };
        }>(["get", "deploy", "core-controller"]);
        const available = deploy.status?.conditions?.some(
          (c) => c.type === "Available" && c.status === "True",
        );
        // `undefined`, not `false`: waitFor treats any non-nullish value as the
        // condition having been met.
        return available ? true : undefined;
      },
      { timeoutMs: 120_000 },
    );
  });

  it("leaves no AgentRun phaseless, the shape a dead controller leaves behind", async () => {
    // The user-visible half of the same bug, and the reason it took ten minutes
    // to notice. An AgentRun is created by the orchestrator but only ever given
    // a phase by core-controller, so an object sitting with none is a run
    // nobody is driving -- which the caller experiences as
    // `went silent for 600000ms after 0 progress message(s)`, a message naming
    // neither RBAC nor the controller.
    //
    // Scoped to runs older than a minute so one created moments ago, mid
    // reconcile, is not read as a stall.
    const list = await kubectlJson<{
      items: { metadata: { name: string; creationTimestamp: string }; status?: { phase?: string } }[];
    }>(["get", "agentruns"]);

    const cutoff = Date.now() - 60_000;
    const stalled = list.items
      .filter((r) => !r.status?.phase && Date.parse(r.metadata.creationTimestamp) < cutoff)
      .map((r) => r.metadata.name);

    expect(
      stalled,
      `${stalled.length} AgentRun(s) in ${NAMESPACE} have no phase a minute after creation:\n${stalled.join("\n")}`,
    ).toEqual([]);
  });
});
