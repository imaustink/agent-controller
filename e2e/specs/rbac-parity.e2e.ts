import { describe, expect, it } from "vitest";
import {
  grantsFromChart,
  grantsFromGeneratedRole,
  grantsFromMarkers,
  missingFrom,
  sorted,
  type Grant,
} from "../support/rbac.js";

/**
 * core-controller's RBAC, checked along the whole chain that carries it:
 *
 *   +kubebuilder:rbac markers  ->  config/rbac/role.yaml  ->  the Helm chart  ->  the cluster
 *
 * Only the last link is installed, and only the first is ever consulted while
 * writing a controller. Every hop between them is copied by hand or by a
 * generator someone has to remember to run, and a hop that is skipped produces
 * the same failure every time: the manager cannot list a kind it watches, the
 * informer never syncs, `Failed to run manager` ends the process, and the pod
 * crashloops. Nothing else in the system reports this. An AgentRun submitted
 * against a controller that never started is simply accepted and left in no
 * phase, and the caller learns about it as
 * `went silent for 600000ms after 0 progress message(s)` -- ten minutes of
 * nothing, naming neither RBAC nor the controller.
 *
 * That is how it shipped: `Add Connection and KnowledgeBase CRDs` (7063e76)
 * regenerated role.yaml with the two new kinds and left the chart's ClusterRole
 * -- the one the template's own comment promises is "kept in lockstep" -- with
 * the previous eight. Both halves of the commit looked complete in review.
 *
 * This spec needs no cluster, deliberately: the first three links are fully
 * decidable from the repo, and should turn red in seconds on a laptop rather
 * than after a deploy. The last link -- whether the cluster in front of us is
 * actually running the chart checked here -- is what `rbac-installed.e2e.ts`
 * covers, and is the only part of the chain that needs minikube.
 */

const markers = grantsFromMarkers();

function describeMissing(label: string, missing: Grant[]): string {
  return [
    `${label} is missing ${missing.length} grant(s) the controller's markers declare:`,
    ...missing.map((g) => `  - ${g}`),
    "",
    "Regenerate with `make manifests` in controllers/core-controller, then mirror the",
    "result into charts/agent-controller/charts/core-controller/templates/rbac.yaml.",
  ].join("\n");
}

describe("core-controller RBAC parity (no cluster)", () => {
  it("parses a marker set that covers every CRD the controller reconciles", () => {
    // A guard on the guard: a refactor that moved the markers or changed their
    // spelling would otherwise make every assertion below vacuously pass.
    for (const kind of [
      "agentruns",
      "agents",
      "connections",
      "identityproviders",
      "integrationroutes",
      "knowledgebases",
      "localtools",
      "skills",
      "toolruns",
      "tools",
    ]) {
      expect(sorted(markers), `markers for ${kind}`).toContain(
        `core.controller-agent.dev/${kind}:list`,
      );
    }
  });

  it("generated role.yaml grants everything the markers declare", () => {
    const missing = missingFrom(markers, grantsFromGeneratedRole());
    expect(missing, describeMissing("controllers/core-controller/config/rbac/role.yaml", missing)).toEqual([]);
  });

  it("the Helm chart's ClusterRole grants everything the markers declare", () => {
    const missing = missingFrom(markers, grantsFromChart());
    expect(missing, describeMissing("the chart's rendered ClusterRole", missing)).toEqual([]);
  });

  it("the Helm chart grants nothing beyond the markers", () => {
    // The other direction, and not pedantry: this ClusterRole is the only thing
    // in the system holding `batch/jobs` create+delete (ADR 0010), so a grant
    // that appears here without a marker behind it is privilege nobody's code
    // asked for and nobody will think to remove.
    const extra = sorted([...grantsFromChart()].filter((g) => !markers.has(g)));
    expect(extra, `the chart grants ${extra.length} permission(s) no marker declares:\n${extra.join("\n")}`).toEqual([]);
  });
});
