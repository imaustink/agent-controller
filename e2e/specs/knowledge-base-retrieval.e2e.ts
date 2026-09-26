import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectl, kubectlApplyStdin, waitFor } from "../support/k8s.js";
import { withQdrant, listCollections, pointCount } from "../support/qdrant.js";
import { chatSubject, chatTurn } from "../support/chat.js";
import { seedAtlassianLink, deleteCredentials } from "../support/credential-store.js";

/**
 * A knowledge base, from a synced corpus to what a caller is allowed to read.
 *
 * This is the assertion the whole pipeline exists for, and the one no unit
 * test can make: a chunk is indexed on the INGESTION credential, which
 * deliberately ignores permissions, and whether a given caller may see it is
 * decided per query by asking the source (ADR 0040). Getting that wrong
 * discloses one client's material to another, and every layer below reports
 * success either way.
 *
 * The fixture is built so both halves are observable at once. Page 102 is in
 * the corpus — the sync put it there — and one of the two callers cannot read
 * it. A retrieval that returns it to that caller is a leak; a retrieval that
 * hides it from the other is the probe failing closed on someone entitled.
 *
 * Everything below the caller is real: the CronJob's own image, the broker,
 * the driver, the embeddings, Qdrant, the probe. Only Confluence is a
 * stand-in, and `fake-confluence-fidelity.e2e.ts` is what keeps that honest.
 */

requireMinikubeContext();

const CONNECTION = "e2e-fake-atlassian";
const CORPUS = "alpha-docs";
const KB = "e2e-alpha";
/**
 * Read from the Corpus, not computed.
 *
 * The controller decides the collection name and reports it; recomputing the
 * scheme here would be a second implementation that agrees with itself and
 * drifts silently — and it did, on the first run: the real name carries the
 * NAMESPACE, which this spec had guessed away.
 */
let COLLECTION = "";

const FULL_USER = "kb-full";
const LIMITED_USER = "kb-limited";

const manifests = `
apiVersion: core.controller-agent.dev/v1alpha1
kind: Connection
metadata:
  name: ${CONNECTION}
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
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: Corpus
metadata:
  name: ${CORPUS}
  labels: { e2e: "true" }
spec:
  connectionRef: ${CONNECTION}
  displayName: "Alpha docs"
  description: "Runbooks and postmortems for the Alpha client."
  allowedRoles: [reader]
  scope:
    space: ALPHA
  sync:
    mode: poll
    reconcileInterval: 1h
  api:
    enabled: true
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: KnowledgeBase
metadata:
  name: ${KB}
  labels: { e2e: "true" }
spec:
  displayName: "Alpha"
  description: "Everything about the Alpha client: deploys, incidents, runbooks."
  corpusRefs:
    - ${CORPUS}
  disclosePartialVisibility: true
`;

/**
 * Runs the corpus's sync now, rather than waiting for its schedule.
 *
 * The CronJob is what production runs, so the Job is created FROM it — a
 * hand-written Job would test a pod spec nobody deploys.
 */
async function syncNow(): Promise<void> {
  const cronjob = (
    await kubectl([
      "get",
      "cronjob",
      "-l",
      `core.controller-agent.dev/corpus=${CORPUS}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ])
  ).trim();
  expect(cronjob, "the corpus has no sync CronJob to trigger").not.toBe("");

  const job = `e2e-sync-${Date.now()}`;
  await kubectl(["create", "job", job, `--from=cronjob/${cronjob}`]);
  await kubectl(["wait", "--for=condition=complete", `job/${job}`, "--timeout=300s"]);
}

beforeAll(async () => {
  await deleteCredentials("identity-link");
  await kubectlApplyStdin(manifests);

  // Both callers link an Atlassian account; they differ in what it can see.
  await seedAtlassianLink(chatSubject(FULL_USER), "e2e-user-full");
  await seedAtlassianLink(chatSubject(LIMITED_USER), "e2e-user-limited", "limited-account");

  await waitFor(
    "the corpus is ready to sync",
    async () => {
      const provider = (
        await kubectl(["get", "corpus", CORPUS, "-o", "jsonpath={.status.provider}"])
      ).trim();
      return provider === "confluence" ? true : undefined;
    },
    { timeoutMs: 120_000 },
  );

  COLLECTION = (
    await kubectl(["get", "corpus", CORPUS, "-o", "jsonpath={.status.collection}"])
  ).trim();
  expect(COLLECTION, "the corpus reports no collection").not.toBe("");

  await syncNow();
}, 600_000);

afterAll(async () => {
  const objects: [kind: string, name: string][] = [
    ["knowledgebase", KB],
    ["corpus", CORPUS],
    ["connection", CONNECTION],
  ];
  for (const [kind, name] of objects) {
    await kubectl(["delete", kind, name, "--ignore-not-found", "--wait=false"]).catch(() => "");
  }
  await deleteCredentials("identity-link");
});

describe("the sync CronJob", () => {
  it("writes the corpus into its own collection", async () => {
    await withQdrant(async (base) => {
      const collections = await listCollections(base);
      expect(collections, `no collection named ${COLLECTION}`).toContain(COLLECTION);

      const points = await pointCount(base, COLLECTION);
      expect(points ?? 0).toBeGreaterThan(0);
    });
  });

  it("indexes a page NO ordinary caller may read, on the ingestion credential", async () => {
    // Ingestion deliberately ignores permissions, which is what makes the
    // probe load-bearing rather than decorative. If this ever stops being
    // true, the leak test below starts passing for the wrong reason.
    await withQdrant(async (base) => {
      const res = await fetch(`${base}/collections/${COLLECTION}/points/scroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 200, with_payload: true }),
      });
      const body = (await res.json()) as {
        result: { points: { payload: Record<string, unknown> }[] };
      };

      const titles = body.result.points.map((p) => {
        const raw = p.payload.descriptor;
        const d = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, string>);
        return d?.title ?? "";
      });

      expect(titles).toContain("Alpha Incident Postmortem");
    });
  });

  it("re-embeds nothing on a second pass", async () => {
    // The incremental story, which rests on content hashes being stable across
    // runs and is invisible to any test that syncs once.
    const before = await withQdrant((base) => pointCount(base, COLLECTION));
    await syncNow();
    const after = await withQdrant((base) => pointCount(base, COLLECTION));

    expect(after).toBe(before);
  }, 600_000);
});

describe("retrieval, as the asking user", () => {
  it("answers from the corpus and cites it", async () => {
    const { text } = await chatTurn(
      FULL_USER,
      "Using the Alpha knowledge base, what does the runbook say about rolling back a deploy?",
      { timeoutMs: 180_000 },
    );

    // The passage, and a citation pointing at the SITE rather than the API.
    expect(text.toLowerCase()).toContain("image tag");
    expect(text).toContain("fake.atlassian.net");
  }, 300_000);

  it("never returns a page the caller cannot open, though it IS indexed", async () => {
    // THE test. The postmortem is in the collection; this caller is refused it
    // by the source; the probe is the only thing standing between them.
    const { text } = await chatTurn(
      LIMITED_USER,
      "Using the Alpha knowledge base, what happened during the incident? Quote the postmortem.",
      { timeoutMs: 180_000 },
    );

    expect(text).not.toContain("the queue backed up");
    expect(text).not.toContain("Alpha Incident Postmortem");
  }, 300_000);

  it("returns that same page to a caller who may open it", async () => {
    // Without this, the assertion above passes just as well when retrieval is
    // broken altogether — which is exactly how a dead probe route looked.
    const { text } = await chatTurn(
      FULL_USER,
      "Using the Alpha knowledge base, what happened during the incident? Quote the postmortem.",
      { timeoutMs: 180_000 },
    );

    expect(text.toLowerCase()).toContain("queue");
  }, 300_000);

  it("tells a caller when something was withheld", async () => {
    // A partial answer the caller believes is complete is worse than one that
    // says what it could not reach — and the silence here once hid a routing
    // bug that drained every result.
    const { text } = await chatTurn(
      LIMITED_USER,
      "Using the Alpha knowledge base, summarise everything you can find about incidents.",
      { timeoutMs: 180_000 },
    );

    expect(text.toLowerCase()).toMatch(/could not see|did not confirm|outside your access/);
  }, 300_000);
});

describe("a caller with no linked account", () => {
  const STRANGER = "kb-unlinked";

  it("is asked to link rather than served on the ingestion credential", async () => {
    // Probing with the service credential would answer a different question,
    // permissively (ADR 0040). The honest response is to ask.
    const { text } = await chatTurn(
      STRANGER,
      "Using the Alpha knowledge base, what does the runbook say?",
      { timeoutMs: 180_000, allowPark: true },
    );

    expect(text.toLowerCase()).toMatch(/link|connect|authorize/);
    expect(text).not.toContain("release branch");
  }, 300_000);
});
