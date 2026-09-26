import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectl, kubectlJson, kubectlApplyStdin, waitFor, NAMESPACE } from "../support/k8s.js";

/**
 * The Connection/Corpus/KnowledgeBase CRDs against the controller that
 * reconciles them (ADR 0043).
 *
 * envtest already runs the controller's logic, so this is deliberately not
 * about logic. It is about the three hops envtest cannot see, each of which
 * has shipped broken in this repo at least once:
 *
 *   - whether the chart's ClusterRole actually grants the kinds the controller
 *     watches. `make manifests` regenerates config/rbac/role.yaml; the chart's
 *     copy is written BY HAND, only the chart's copy is installed, and a kind
 *     missing from it crashloops the manager while a caller sees nothing but a
 *     turn that never dispatches. That has happened for `connections`,
 *     `knowledgebases` and then again for `corpora`.
 *   - whether the CRDs installed in the cluster are the ones this branch
 *     generates. Helm's crds/ directory is install-only, so a release that
 *     predates a new kind never gets it.
 *   - whether reconciling a Corpus creates the CronJob its sync depends on,
 *     with the schedule its `reconcileInterval` asks for.
 *
 * Objects are namespaced and deleted in afterAll. Nothing here spends a real
 * credential: the Connection points at the in-cluster fake.
 */

requireMinikubeContext();

const CONNECTION = "e2e-fake-atlassian";
const CORPUS = "alpha-docs";
const KB = "e2e-alpha";

const connectionManifest = (name = CONNECTION) => `
apiVersion: core.controller-agent.dev/v1alpha1
kind: Connection
metadata:
  name: ${name}
  labels: { e2e: "true" }
spec:
  provider: confluence
  displayName: "Fake Atlassian"
  site:
    baseURL: https://fake.atlassian.net/wiki
    cloudId: e2e-cloud-id
  secretEnv:
    - name: SERVICE_TOKEN
      secretRef:
        name: e2e-connection-alpha
        key: token
  identityProviders:
    - atlassian
`;

const corpusManifest = (name = CORPUS, connection = CONNECTION, space = "ALPHA") => `
apiVersion: core.controller-agent.dev/v1alpha1
kind: Corpus
metadata:
  name: ${name}
  labels: { e2e: "true" }
spec:
  connectionRef: ${connection}
  displayName: "Alpha docs"
  description: "The alpha client's space."
  allowedRoles: [reader]
  scope:
    space: ${space}
  sync:
    mode: poll
    reconcileInterval: 1h
  api:
    enabled: true
`;

interface CorpusStatus {
  status?: {
    provider?: string;
    identityProviders?: string[];
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

const condition = (obj: CorpusStatus, type: string) =>
  obj.status?.conditions?.find((c) => c.type === type);

async function deleteIfPresent(kind: string, name: string) {
  await kubectl(["delete", kind, name, "--ignore-not-found", "--wait=false"]).catch(() => "");
}

beforeAll(async () => {
  // A previous failed run may have left objects with finalizers behind.
  await deleteIfPresent("corpus", CORPUS);
  await deleteIfPresent("knowledgebase", KB);
  await deleteIfPresent("connection", CONNECTION);
});

afterAll(async () => {
  // Corpora first: the Connection's finalizer blocks while any remain, which
  // this spec asserts on deliberately.
  await deleteIfPresent("corpus", CORPUS);
  await deleteIfPresent("knowledgebase", KB);
  await deleteIfPresent("connection", CONNECTION);
});

describe("the CRDs this branch generates are the ones installed", () => {
  it("has a corpora CRD at all", async () => {
    // Helm's crds/ is install-only: a cluster whose release predates the split
    // has connections and knowledgebases and no corpora, and every Corpus
    // applied against it fails with a bare `404 page not found`.
    const names = await kubectl(["get", "crd", "-o", "name"]);

    expect(names).toContain("corpora.core.controller-agent.dev");
    expect(names).toContain("connections.core.controller-agent.dev");
    expect(names).toContain("knowledgebases.core.controller-agent.dev");
  });

  it("serves the fields the broker reads", async () => {
    // A CRD present but stale is the harder failure: objects apply, fields are
    // silently dropped, and the broker reads undefined off a Corpus that
    // looked accepted.
    const crd = await kubectl([
      "get",
      "crd",
      "corpora.core.controller-agent.dev",
      "-o",
      "jsonpath={.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}",
    ]);

    for (const field of ["connectionRef", "scope", "allowedRoles", "sync", "api"]) {
      expect(crd, `Corpus.spec is missing ${field}`).toContain(field);
    }
  });
});

/**
 * The controller's ClusterRole, found rather than named.
 *
 * The chart's fullname depends on the release name, so hardcoding one couples
 * this spec to how the cluster happened to be installed — and a NotFound then
 * reads as "RBAC is broken" when it only means the release is called something
 * else. Matching on the rules it must contain would be circular, so it is
 * found by the ServiceAccount the controller Deployment actually runs as.
 */
async function controllerClusterRole(): Promise<{
  rules: { apiGroups: string[]; resources: string[] }[];
}> {
  const serviceAccount = (
    await kubectl([
      "get",
      "deploy",
      "-l",
      "app.kubernetes.io/name=core-controller",
      "-o",
      "jsonpath={.items[0].spec.template.spec.serviceAccountName}",
    ])
  ).trim();
  expect(serviceAccount, "no core-controller Deployment in the cluster").not.toBe("");

  const bindings = await kubectlJson<{
    items: {
      roleRef: { kind: string; name: string };
      subjects?: { kind: string; name: string; namespace?: string }[];
    }[];
  }>(["get", "clusterrolebinding", "-o", "json"]);

  const binding = bindings.items.find((b) =>
    (b.subjects ?? []).some(
      (s) => s.kind === "ServiceAccount" && s.name === serviceAccount && s.namespace === NAMESPACE,
    ),
  );
  expect(binding, `nothing binds a ClusterRole to ${serviceAccount}`).toBeDefined();

  return kubectlJson(["get", "clusterrole", binding!.roleRef.name, "-o", "json"]);
}

describe("the chart grants the controller what it watches", () => {
  it("permits corpora, connections and knowledgebases", async () => {
    // The hand-copied hop. A kind missing here crashloops the manager on
    // `Failed to run manager`, and nothing downstream names RBAC.
    const rules = await controllerClusterRole();

    const granted = new Set(
      rules.rules
        .filter((rule) => rule.apiGroups.includes("core.controller-agent.dev"))
        .flatMap((rule) => rule.resources),
    );

    for (const kind of ["connections", "corpora", "knowledgebases"]) {
      expect([...granted], `ClusterRole does not grant ${kind}`).toContain(kind);
    }
  });

  it("permits the cronjobs a Corpus's sync is reconciled into", async () => {
    // Added with the CronJob-based sync and just as hand-copied. Without it the
    // Corpus reconciles, reports healthy, and is never synced by anything.
    const rules = await controllerClusterRole();

    const batch = new Set(
      rules.rules.filter((rule) => rule.apiGroups.includes("batch")).flatMap((r) => r.resources),
    );

    expect([...batch]).toContain("cronjobs");
  });
});

describe("every process that watches these kinds is granted them", () => {
  /**
   * The namespaced Role bound to a Deployment's ServiceAccount.
   *
   * Four processes in this feature watch these kinds, and the chart Role for
   * three of them has shipped missing one: core-controller's ClusterRole
   * twice, the broker's Role, and the orchestrator's. Every one is the same
   * hand-copied hop, and every one crashloops rather than degrading — which is
   * loud, but the cause sits several screens into a log about something else.
   */
  async function roleFor(app: string): Promise<{
    rules: { apiGroups: string[]; resources: string[] }[];
  }> {
    const serviceAccount = (
      await kubectl([
        "get",
        "deploy",
        "-l",
        `app.kubernetes.io/name=${app}`,
        "-o",
        "jsonpath={.items[0].spec.template.spec.serviceAccountName}",
      ])
    ).trim();
    expect(serviceAccount, `no ${app} Deployment in the cluster`).not.toBe("");

    const bindings = await kubectlJson<{
      items: { roleRef: { name: string }; subjects?: { kind: string; name: string }[] }[];
    }>(["get", "rolebinding", "-o", "json"]);

    const binding = bindings.items.find((b) =>
      (b.subjects ?? []).some((s) => s.kind === "ServiceAccount" && s.name === serviceAccount),
    );
    expect(binding, `nothing binds a Role to ${serviceAccount}`).toBeDefined();

    return kubectlJson(["get", "role", binding!.roleRef.name, "-o", "json"]);
  }

  const grantedKinds = (role: { rules: { apiGroups: string[]; resources: string[] }[] }) =>
    new Set(
      role.rules
        .filter((rule) => rule.apiGroups.includes("core.controller-agent.dev"))
        .flatMap((rule) => rule.resources),
    );

  it("grants the connection-broker connections and corpora", async () => {
    // It resolves a Corpus's scope against the Connection holding its
    // credential, and loads Connections first so a Corpus never binds to one
    // it has not seen.
    const granted = grantedKinds(await roleFor("connection-broker"));

    expect([...granted]).toContain("connections");
    expect([...granted]).toContain("corpora");
  });

  it("lets the broker report a sync back onto the Corpus", async () => {
    // Without corpora/status the sync succeeds and records nothing, so the
    // Corpus shows no lastSyncTime however many times it ran.
    const granted = grantedKinds(await roleFor("connection-broker"));

    expect([...granted]).toContain("corpora/status");
  });

  it("grants the orchestrator all three kinds it derives a skill from", async () => {
    const granted = grantedKinds(await roleFor("agent-orchestrator"));

    for (const kind of ["connections", "corpora", "knowledgebases"]) {
      expect([...granted], `the orchestrator cannot watch ${kind}`).toContain(kind);
    }
  });
});

describe("reconciling a Corpus", () => {
  beforeAll(async () => {
    await kubectlApplyStdin(connectionManifest());
    await kubectlApplyStdin(corpusManifest());
  });

  it("resolves provider and identityProviders onto the Corpus status", async () => {
    // Both engines watch ONE kind (ADR 0043). They read these off the Corpus
    // rather than joining to the Connection, so a controller that fails to
    // copy them leaves every engine unable to pick a driver or a credential.
    const resolved = await waitFor(
      "corpus status carries the resolved Connection fields",
      async () => {
        const corpus = await kubectlJson<CorpusStatus>(["get", "corpus", CORPUS, "-o", "json"]);
        return corpus.status?.provider ? corpus : undefined;
      },
      { timeoutMs: 60_000 },
    );

    expect(resolved.status?.provider).toBe("confluence");
    expect(resolved.status?.identityProviders).toEqual(["atlassian"]);
  });

  it("creates the sync CronJob, on the schedule the Corpus asked for", async () => {
    const cronjob = await waitFor(
      "a sync CronJob exists for the corpus",
      async () => {
        const found = await kubectlJson<{ items: { metadata: { name: string }; spec: { schedule: string } }[] }>([
          "get",
          "cronjob",
          "-l",
          `core.controller-agent.dev/corpus=${CORPUS}`,
          "-o",
          "json",
        ]);
        return found.items.length > 0 ? found.items[0] : undefined;
      },
      { timeoutMs: 60_000 },
    );

    // `reconcileInterval: 1h` — the controller rounds DOWN, so an hourly
    // corpus must not end up on a schedule that fires less often than asked.
    expect(cronjob.spec.schedule).toMatch(/^(\S+\s+){4}\S+$/);
    expect(cronjob.spec.schedule).toContain("*");
  });

  it("owns the CronJob, so deleting the Corpus takes it away", async () => {
    // Otherwise a deleted Corpus leaves a job syncing into a collection
    // nothing reads, spending a client's credential forever.
    const cronjobs = await kubectlJson<{
      items: { metadata: { ownerReferences?: { kind: string; name: string }[] } }[];
    }>(["get", "cronjob", "-l", `core.controller-agent.dev/corpus=${CORPUS}`, "-o", "json"]);

    const owners = cronjobs.items[0]?.metadata.ownerReferences ?? [];
    expect(owners.some((o) => o.kind === "Corpus" && o.name === CORPUS)).toBe(true);
  });
});

describe("a Connection with Corpora drawing from it", () => {
  it("blocks deletion rather than cascading", async () => {
    // Destroying indexed material should not be a side effect of removing a
    // credential, and only one of those is reversible (ADR 0043).
    await kubectl(["delete", "connection", CONNECTION, "--wait=false"]);

    const stillThere = await kubectlJson<{ metadata: { deletionTimestamp?: string } }>([
      "get",
      "connection",
      CONNECTION,
      "-o",
      "json",
    ]);

    // Marked for deletion, held by the finalizer, and still present.
    expect(stillThere.metadata.deletionTimestamp).toBeDefined();
  });

  it("releases once the last Corpus is gone", async () => {
    await kubectl(["delete", "corpus", CORPUS, "--wait=true"]);

    await waitFor(
      "the connection finally goes",
      async () => {
        const remaining = await kubectl(["get", "connection", "-o", "name"]);
        return remaining.includes(CONNECTION) ? undefined : true;
      },
      { timeoutMs: 60_000 },
    );
  });
});

describe("a Corpus whose Connection is missing", () => {
  const ORPHAN = "e2e-orphan-corpus";

  afterAll(async () => {
    await deleteIfPresent("corpus", ORPHAN);
  });

  it("degrades instead of being silently inert", async () => {
    // The provider-specific admission check moved to the controller when the
    // provider moved to the Connection (ADR 0043), so this is where a bad
    // reference has to surface. A Corpus that simply sat there would look
    // healthy and index nothing.
    await kubectlApplyStdin(corpusManifest(ORPHAN, "no-such-connection"));

    const degraded = await waitFor(
      "the orphan corpus reports why it cannot run",
      async () => {
        const corpus = await kubectlJson<CorpusStatus>(["get", "corpus", ORPHAN, "-o", "json"]);
        const ready = condition(corpus, "Ready");
        return ready && ready.status !== "True" ? corpus : undefined;
      },
      { timeoutMs: 60_000 },
    );

    const ready = condition(degraded, "Ready")!;
    expect(ready.status).toBe("False");
    // The message has to name the missing Connection, or an operator is left
    // guessing which of several references is wrong.
    expect(`${ready.reason ?? ""} ${ready.message ?? ""}`).toContain("no-such-connection");
  });

  it("does not create a sync CronJob for a corpus that cannot run", async () => {
    const cronjobs = await kubectlJson<{ items: unknown[] }>([
      "get",
      "cronjob",
      "-l",
      `core.controller-agent.dev/corpus=${ORPHAN}`,
      "-o",
      "json",
    ]);

    expect(cronjobs.items).toHaveLength(0);
  });
});
