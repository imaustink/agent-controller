import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince, kubectl, kubectlJson, waitFor } from "../support/k8s.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { deployedEngine } from "../support/engine.js";
import {
  TICK_TOKEN_AUDIENCE,
  applyEventSource,
  deleteEventFixtures,
  readyCondition,
  runJobFlags,
  runSuffix,
  waitForAgentRunWithParam,
  waitForReady,
} from "../support/events.js";

requireMinikubeContext();

/**
 * Cron EventSources (docs/event-triggers.md §8): core-controller materializes
 * each as an OWNED CronJob that curls integration-gateway's tick endpoint as
 * the source's own (owned) ServiceAccount; the gateway builds the envelope with the CR's
 * `payload` as its body; triggers read it exactly like a webhook body.
 *
 * Ticks are driven explicitly, never waited for on the shipped schedule:
 * the e2e overlay (e2e/manifests/event-triggers) SUSPENDS nightly-sweep, and `kubectl
 * create job --from=cronjob/...` runs the very Job template the schedule would
 * -- same image, args, ServiceAccount -- on demand. A per-test source with an
 * every-minute schedule covers the scheduler path itself (cheaply: it has no
 * trigger, so its ticks start no turn).
 *
 * Out of scope here: a cron source while EVENT_TICK_URL is unset
 * (TickNotConfigured) -- that needs a differently-configured controller and is
 * covered by core-controller's envtest suite.
 */

const FIXTURE = "cron";
const SHARED_SUBJECT = "client-integration-gateway";
/** nightly-sweep's payload as e2e/manifests/event-triggers patches it. */
const SWEEP_PAYLOAD = { repo: "e2e-org/e2e-repo", limit: "3" };

interface CronJobView {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
  };
  spec: {
    schedule: string;
    suspend?: boolean;
    concurrencyPolicy?: string;
    jobTemplate: {
      spec: {
        template: {
          spec: {
            serviceAccountName?: string;
            automountServiceAccountToken?: boolean;
            volumes?: { projected?: { sources?: { serviceAccountToken?: { audience?: string; path: string } }[] } }[];
            containers: {
              args?: string[];
              command?: string[];
              env?: { name: string }[];
            }[];
          };
        };
      };
    };
  };
}

const cronJob = (name: string) => kubectlJson<CronJobView>(["get", "cronjob", name]);

async function cronJobGone(name: string): Promise<boolean> {
  return (await kubectl(["get", "cronjob", name, "--ignore-not-found", "-o", "name"])).trim() === "";
}

describe(`cron EventSources (engine: ${deployedEngine()})`, () => {
  let startedAt: Date;
  const manualJobs: string[] = [];

  beforeAll(async () => {
    startedAt = new Date();
    await seedAllClaudeCredentials(SHARED_SUBJECT);
  });

  afterAll(async () => {
    for (const job of manualJobs) {
      await kubectl(["delete", "job", job, "--ignore-not-found", "--wait=false"]).catch(() => undefined);
    }
    await deleteEventFixtures(FIXTURE);
    await cleanupAgentRunsSince(startedAt);
  });

  it("materializes nightly-sweep as an owned, hardened CronJob that ticks the gateway as its own ServiceAccount", async () => {
    const ready = await waitForReady("eventsource", "nightly-sweep", "True", "Scheduled");
    expect(ready.status).toBe("True");
    const source = await kubectlJson<{ spec: { cron: { schedule: string } }; status?: { cronJobName?: string } }>([
      "get",
      "eventsource",
      "nightly-sweep",
    ]);
    expect(source.status?.cronJobName).toBe("eventsource-nightly-sweep");

    const cj = await cronJob("eventsource-nightly-sweep");
    expect(cj.metadata.labels?.["core.controller-agent.dev/eventsource"]).toBe("nightly-sweep");
    expect(cj.metadata.ownerReferences).toContainEqual(
      expect.objectContaining({ kind: "EventSource", name: "nightly-sweep", controller: true }),
    );
    expect(cj.spec.schedule).toBe(source.spec.cron.schedule);
    // The e2e overlay suspends it so nothing fires on its own during a run.
    expect(cj.spec.suspend).toBe(true);
    // One tick is one turn: never two stacked.
    expect(cj.spec.concurrencyPolicy).toBe("Forbid");

    // Its identity: an owned ServiceAccount of the same name, with no token
    // of its own auto-mounted and no RoleBinding (it authenticates, nothing more).
    const sa = await kubectlJson<{
      metadata: { ownerReferences?: { kind: string; name: string; controller?: boolean }[] };
      automountServiceAccountToken?: boolean;
    }>(["get", "serviceaccount", "eventsource-nightly-sweep"]);
    expect(sa.metadata.ownerReferences).toContainEqual(
      expect.objectContaining({ kind: "EventSource", name: "nightly-sweep", controller: true }),
    );
    expect(sa.automountServiceAccountToken).toBe(false);

    const pod = cj.spec.jobTemplate.spec.template.spec;
    expect(pod.serviceAccountName).toBe("eventsource-nightly-sweep");
    expect(pod.automountServiceAccountToken, "no API-server token: only the gateway-audience one").toBe(false);
    expect(pod.volumes?.[0]?.projected?.sources?.[0]?.serviceAccountToken).toMatchObject({
      audience: TICK_TOKEN_AUDIENCE,
      path: "token",
    });
    const container = pod.containers[0];
    const argv = [...(container?.command ?? []), ...(container?.args ?? [])].join(" ");
    expect(argv).toMatch(/\/events\/nightly-sweep\/tick$/);
    expect(argv).toContain("-X POST");
    // curl reads the token file itself: it is never on the command line or in env.
    expect(argv).toContain("Authorization: Bearer {{token:trim}}");
    expect(container?.env ?? []).toEqual([]);
  });

  it("a Job run from that CronJob ticks -> nightly-stale-sweep -> a read-only AgentRun with the payload as params", async () => {
    const job = `e2e-tick-${runSuffix()}`;
    manualJobs.push(job);
    const tickAt = new Date();
    await kubectl(["create", "job", `--from=cronjob/eventsource-nightly-sweep`, job]);

    // curl -f: the Job succeeds only on a 2xx from the gateway -- i.e. the
    // pod's projected ServiceAccount token passed TokenReview as THIS source's
    // identity, and the route exists.
    await waitFor(
      `tick Job ${job} to succeed`,
      async () => {
        const j = await kubectlJson<{ status?: { succeeded?: number; failed?: number } }>(["get", "job", job]);
        if ((j.status?.failed ?? 0) > 0) throw new Error(`tick Job ${job} failed (the gateway rejected the tick?)`);
        return (j.status?.succeeded ?? 0) > 0 ? true : undefined;
      },
      { timeoutMs: 180_000 },
    );

    const run = await waitForAgentRunWithParam(tickAt, "repo", SWEEP_PAYLOAD.repo);
    expect(run.agentRef).toBe("stub-agent");
    // The payload is the envelope body; params are its string forms (§4).
    expect(run.params).toEqual(SWEEP_PAYLOAD);
    expect(run.readOnly).toBe(true);
    expect(run.goal).toContain(`Sweep ${SWEEP_PAYLOAD.repo} for stale work`);
    const flags = await waitFor("the sweep run's Job", async () => runJobFlags(run.jobName ?? run.name).catch(() => undefined), {
      timeoutMs: 120_000,
    });
    expect(flags.AGENT_READ_ONLY).toBe("true");
  });

  it("a per-test every-minute source fires on schedule, and suspend / schedule / delete all propagate", async () => {
    const name = `e2e-cron-${runSuffix()}`;
    const cronJobName = `eventsource-${name}`;
    // No trigger names this source, so its ticks are accepted (202) and match
    // nothing: the scheduler path end to end, without a turn per minute.
    await applyEventSource(name, { cron: { schedule: "* * * * *", payload: { e2e: name } } }, FIXTURE);
    await waitForReady("eventsource", name, "True", "Scheduled");
    expect((await cronJob(cronJobName)).spec.schedule).toBe("* * * * *");

    // The scheduler fires it, and the tick is accepted (curl -f).
    await waitFor(
      `a scheduled tick Job from ${cronJobName} to succeed`,
      async () => {
        const jobs = await kubectlJson<{
          items: { metadata: { ownerReferences?: { name: string }[] }; status?: { succeeded?: number } }[];
        }>(["get", "jobs"]);
        return jobs.items.some(
          (j) => j.metadata.ownerReferences?.some((o) => o.name === cronJobName) && (j.status?.succeeded ?? 0) > 0,
        )
          ? true
          : undefined;
      },
      { timeoutMs: 180_000, intervalMs: 5_000 },
    );

    await kubectl(["patch", "eventsource", name, "--type", "merge", "-p", JSON.stringify({ spec: { cron: { suspend: true } } })]);
    await waitFor(`${cronJobName} to be suspended`, async () => ((await cronJob(cronJobName)).spec.suspend === true ? true : undefined));

    await kubectl([
      "patch",
      "eventsource",
      name,
      "--type",
      "merge",
      "-p",
      JSON.stringify({ spec: { cron: { schedule: "*/7 * * * *" } } }),
    ]);
    await waitFor(`${cronJobName} to take the new schedule`, async () =>
      (await cronJob(cronJobName)).spec.schedule === "*/7 * * * *" ? true : undefined,
    );

    await kubectl(["delete", "eventsource", name, "--wait=false"]);
    // Owned: garbage-collected with its source. An orphan would 404 every tick.
    await waitFor(`${cronJobName} to be garbage-collected`, async () => ((await cronJobGone(cronJobName)) ? true : undefined), {
      timeoutMs: 120_000,
    });
  });

  it("rejects or refuses an invalid schedule, and never materializes a CronJob for it", async () => {
    const name = `e2e-badcron-${runSuffix()}`;
    let rejectedAtAdmission = false;
    try {
      await applyEventSource(name, { cron: { schedule: "every tuesday-ish" } }, FIXTURE);
    } catch {
      rejectedAtAdmission = true;
    }
    if (!rejectedAtAdmission) {
      const c = await waitForReady("eventsource", name, "False", "InvalidSchedule");
      expect(c.reason).toBe("InvalidSchedule");
    }
    expect(await cronJobGone(`eventsource-${name}`)).toBe(true);
    // Not vacuous: the valid source above DID get one under the same rule.
    expect(await readyCondition("eventsource", "nightly-sweep")).toMatchObject({ status: "True" });
  });
});
