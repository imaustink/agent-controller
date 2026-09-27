import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectl, kubectlApplyStdin, waitFor } from "../support/k8s.js";
import { withQdrant, pointCount } from "../support/qdrant.js";

/**
 * Slack and Drive corpora, synced through the real CronJob into real Qdrant.
 *
 * Only Confluence went through the full cluster path before this. The drivers
 * are covered against their fakes, and the broker's routes are covered against
 * fake drivers, but nothing had ever run a SLACK or DRIVE corpus through the
 * controller, the CronJob, the broker and the store together — which is where
 * every bug in this PR has actually lived.
 *
 * What this spec is for, beyond "it also works":
 *
 *   The CronJob is rendered per Corpus and its sync token is keyed per corpus,
 *   so a second and third provider are the first time that keying is exercised
 *   with more than one entry. A shared token would let any corpus drive
 *   another's ingestion credential, and a mis-keyed one fails as
 *   "unrecognized bearer token" — which reads as a wrong VALUE rather than a
 *   wrong NAME, and cost an hour the first time.
 *
 *   Each provider lands in its OWN collection. Two corpora sharing one would
 *   mix two clients' material behind a single role stamp.
 */

requireMinikubeContext();

const SLACK_CORPUS = "eng-chat";
const DRIVE_CORPUS = "delivery-drive";

const manifests = `
apiVersion: core.controller-agent.dev/v1alpha1
kind: Connection
metadata:
  name: e2e-fake-slack
  labels: { e2e: "true" }
spec:
  provider: slack
  displayName: "Fake Slack"
  site:
    baseURL: https://fake.slack.com
  # The one WRITE a driver performs, opt-in per Connection. #eng refuses the
  # bot until it joins, so a corpus over it cannot sync without this.
  autoJoin: true
  secretEnv:
    - name: SERVICE_TOKEN
      secretRef:
        name: e2e-connection-slack
        key: token
  identityProviders:
    - slack
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: Corpus
metadata:
  name: ${SLACK_CORPUS}
  labels: { e2e: "true" }
spec:
  connectionRef: e2e-fake-slack
  displayName: "#eng"
  description: "Deploy chatter and incident threads for the engineering team."
  allowedRoles: [reader]
  scope:
    channel: CENG
  sync:
    mode: poll
    reconcileInterval: 1h
  api:
    enabled: true
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: Connection
metadata:
  name: e2e-fake-gdrive
  labels: { e2e: "true" }
spec:
  provider: gdrive
  displayName: "Fake Drive"
  secretEnv:
    - name: SERVICE_TOKEN
      secretRef:
        name: e2e-connection-gdrive
        key: token
  identityProviders:
    - google
---
apiVersion: core.controller-agent.dev/v1alpha1
kind: Corpus
metadata:
  name: ${DRIVE_CORPUS}
  labels: { e2e: "true" }
spec:
  connectionRef: e2e-fake-gdrive
  displayName: "Delivery drive"
  description: "Statements of work and delivery documents."
  allowedRoles: [reader]
  scope:
    folderID: FROOT
  sync:
    mode: poll
    reconcileInterval: 1h
  api:
    enabled: true
`;

/** Runs a corpus's sync from its own CronJob — the pod spec production deploys. */
async function syncNow(corpus: string): Promise<void> {
  const cronjob = (
    await kubectl([
      "get",
      "cronjob",
      "-l",
      `core.controller-agent.dev/corpus=${corpus}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ])
  ).trim();
  expect(cronjob, `${corpus} has no sync CronJob`).not.toBe("");

  const job = `e2e-sync-${corpus}-${Date.now()}`;
  await kubectl(["create", "job", job, `--from=cronjob/${cronjob}`]);
  await kubectl(["wait", "--for=condition=complete", `job/${job}`, "--timeout=300s"]);
}

const collectionOf = async (corpus: string) =>
  (await kubectl(["get", "corpus", corpus, "-o", "jsonpath={.status.collection}"])).trim();

beforeAll(async () => {
  await kubectlApplyStdin(manifests);

  for (const corpus of [SLACK_CORPUS, DRIVE_CORPUS]) {
    await waitFor(
      `${corpus} resolved its Connection`,
      async () => {
        const provider = (
          await kubectl(["get", "corpus", corpus, "-o", "jsonpath={.status.provider}"])
        ).trim();
        return provider ? provider : undefined;
      },
      { timeoutMs: 120_000 },
    );
    await syncNow(corpus);
  }
}, 900_000);

afterAll(async () => {
  for (const [kind, name] of [
    ["corpus", SLACK_CORPUS],
    ["corpus", DRIVE_CORPUS],
    ["connection", "e2e-fake-slack"],
    ["connection", "e2e-fake-gdrive"],
  ] as [string, string][]) {
    await kubectl(["delete", kind, name, "--ignore-not-found", "--wait=false"]).catch(() => "");
  }
});

describe("a Slack corpus", () => {
  it("resolves its provider and identity providers from the Connection", async () => {
    const status = await kubectl([
      "get",
      "corpus",
      SLACK_CORPUS,
      "-o",
      "jsonpath={.status.provider}/{.status.identityProviders[0]}",
    ]);

    expect(status.trim()).toBe("slack/slack");
  });

  it("syncs threads into its own collection", async () => {
    const collection = await collectionOf(SLACK_CORPUS);
    expect(collection).not.toBe("");

    const points = await withQdrant((base) => pointCount(base, collection));
    expect(points ?? 0).toBeGreaterThan(0);
  });

  it("recorded the pass on the Corpus", async () => {
    // The status write-back, which never worked until this PR: every sync
    // succeeded and silently recorded nothing.
    const resources = (
      await kubectl(["get", "corpus", SLACK_CORPUS, "-o", "jsonpath={.status.resources}"])
    ).trim();

    expect(Number(resources)).toBeGreaterThan(0);
  });

  it("joined the channel it was refused, because the Connection asked", async () => {
    // #eng refuses the bot with not_in_channel until it joins. A corpus that
    // synced at all proves the lazy join happened — there is no other way in.
    const collection = await collectionOf(SLACK_CORPUS);
    const points = await withQdrant((base) => pointCount(base, collection));

    expect(points ?? 0).toBeGreaterThan(0);
  });
});

describe("a Drive corpus", () => {
  it("resolves its provider and identity providers from the Connection", async () => {
    const status = await kubectl([
      "get",
      "corpus",
      DRIVE_CORPUS,
      "-o",
      "jsonpath={.status.provider}/{.status.identityProviders[0]}",
    ]);

    expect(status.trim()).toBe("gdrive/google");
  });

  it("syncs files into its own collection", async () => {
    const collection = await collectionOf(DRIVE_CORPUS);
    const points = await withQdrant((base) => pointCount(base, collection));

    expect(points ?? 0).toBeGreaterThan(0);
  });

  it("indexed the nested file and the shortcut, not just direct children", async () => {
    // Both were invisible to the driver before this PR, and both fail the same
    // way: the corpus holds less than it claims with nothing reporting it.
    const collection = await collectionOf(DRIVE_CORPUS);

    const titles = await withQdrant(async (base) => {
      const res = await fetch(`${base}/collections/${collection}/points/scroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 200, with_payload: true }),
      });
      const body = (await res.json()) as {
        result: { points: { payload: Record<string, unknown> }[] };
      };
      return body.result.points.map((p) => {
        const raw = p.payload.descriptor;
        const d = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, string>);
        return d?.title ?? "";
      });
    });

    expect(titles).toContain("Nested brief");
    expect(titles).toContain("Shortcut to notes");
  });
});

describe("the three corpora stay separate", () => {
  it("each lands in its own collection", async () => {
    // One shared collection would mix clients' material behind a single role
    // stamp, which is what the per-Corpus collection exists to prevent.
    const slack = await collectionOf(SLACK_CORPUS);
    const drive = await collectionOf(DRIVE_CORPUS);

    expect(slack).not.toBe(drive);
    expect(slack).not.toBe("");
    expect(drive).not.toBe("");
  });

  it("each has its OWN sync token, keyed by corpus name", async () => {
    // A shared token would let any corpus drive another's ingestion
    // credential. The keying is only really exercised with more than one
    // entry, which is what a second and third provider add.
    const keys = await kubectl([
      "get",
      "secret",
      "e2e-connection-broker-sync-tokens",
      "-o",
      "jsonpath={.data}",
    ]);

    expect(keys).toContain("SYNC_TOKEN_ENG_CHAT");
    expect(keys).toContain("SYNC_TOKEN_DELIVERY_DRIVE");
  });

  it("does not put one provider's material in another's collection", async () => {
    const slackCollection = await collectionOf(SLACK_CORPUS);

    const titles = await withQdrant(async (base) => {
      const res = await fetch(`${base}/collections/${slackCollection}/points/scroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 200, with_payload: true }),
      });
      const body = (await res.json()) as {
        result: { points: { payload: Record<string, unknown> }[] };
      };
      return body.result.points.map((p) => {
        const raw = p.payload.descriptor;
        const d = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, string>);
        return `${d?.title ?? ""} ${d?.connectionId ?? ""}`;
      });
    });

    for (const title of titles) {
      expect(title).toContain(SLACK_CORPUS);
      expect(title).not.toContain("Statement of Work");
    }
  });
});
