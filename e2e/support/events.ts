import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  fetchThrough,
  kubectl,
  kubectlApplyStdin,
  kubectlJson,
  waitFor,
  withPortForward,
  type PortForward,
} from "./k8s.js";
import { fakeGithubRequests, type RecordedRequest } from "./fixtures.js";

/**
 * Shared harness for the event-trigger specs (docs/adr/0048,
 * docs/event-triggers.md): the gateway forward, the Secrets each example
 * EventSource verifies with, per-test EventSource/EventTrigger CRs, the
 * `/invoke`-with-an-envelope entry point, and readers for what a turn LEFT
 * behind (AgentRuns with their readOnly/params, ToolRuns, GitHub comments).
 *
 * Kept apart from k8s.ts (generic kubectl plumbing) because everything here
 * encodes the event-trigger CONTRACT -- the Secret names values-e2e.yaml wires,
 * the CronJob naming rule, the envelope shape -- and a contract change should
 * have one obvious file to update.
 */

// ── the gateway ──────────────────────────────────────────────────────────────

export const GATEWAY_SERVICE = "agent-controller-integration-gateway";
export const GATEWAY_PORT = 8090;
/** Local port for every event-trigger spec's gateway forward (serial suite; one at a time). */
export const EVENTS_GATEWAY_LOCAL_PORT = 18110;

/** Runs `body` with a forward to integration-gateway. */
export function withGateway<T>(body: (forward: PortForward) => Promise<T>): Promise<T> {
  return withPortForward(GATEWAY_SERVICE, GATEWAY_PORT, EVENTS_GATEWAY_LOCAL_PORT, (_baseUrl, forward) => body(forward));
}

// ── secrets ──────────────────────────────────────────────────────────────────

/**
 * The Secrets the example EventSources and reply.http triggers reference in
 * values-e2e.yaml. bootstrap-secrets.sh creates them with FIXED values (see the
 * comment there for why fixed); {@link ensureEventSecrets} re-creates any that
 * are missing so a spec never fails because someone deleted one by hand.
 */
export const EVENT_SECRETS = {
  github: { name: "e2e-integration-gateway-secrets", key: "GITHUB_WEBHOOK_SECRET" },
  slack: { name: "slack-event-source", key: "signingSecret", value: "e2e-slack-signing-secret" },
  ci: { name: "ci-event-source", key: "token", value: "e2e-ci-bearer-token" },
  genericHmac: { name: "generic-hmac-event-source", key: "secret", value: "e2e-generic-hmac-secret" },
  reply: { name: "e2e-event-reply", key: "secret", value: "e2e-event-reply-signing-secret" },
} as const;

/** Audience a cron tick's projected token is minted for (core-controller TickTokenAudience). */
export const TICK_TOKEN_AUDIENCE = "integration-gateway.events";

/**
 * A short-lived token for a ServiceAccount via the TokenRequest API -- the
 * same kind of token a tick pod's projected volume holds (minus the pod
 * binding). `audience` defaults to the gateway's; pass another to prove a
 * token minted for someone else is refused.
 */
export async function mintServiceAccountToken(serviceAccount: string, audience: string = TICK_TOKEN_AUDIENCE): Promise<string> {
  return (await kubectl(["create", "token", serviceAccount, "--audience", audience, "--duration", "10m"])).trim();
}

/** A cron source's tick token: its own ServiceAccount, eventsource-<name>. */
export const tickToken = (source: string) => mintServiceAccountToken(`eventsource-${source}`);

/**
 * One Secret key's decoded value, read from the cluster. Read rather than
 * hardcoded: the specs must sign with whatever the deployment actually verifies
 * against. Never logged, never asserted on -- signing is the only use.
 */
export async function secretValue(name: string, key: string): Promise<string> {
  const b64 = (await kubectl(["get", "secret", name, "-o", `jsonpath={.data.${key.replace(/\./g, "\\.")}}`])).trim();
  if (!b64) throw new Error(`e2e: Secret ${name} has no key ${key} (run e2e/scripts/bootstrap-secrets.sh)`);
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Creates-or-updates an Opaque Secret with one key. Used for per-test Secrets and the fixed event secrets. */
export async function upsertSecret(name: string, key: string, value: string, labels: Record<string, string> = {}): Promise<void> {
  await kubectlApplyStdin(
    JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels: { "e2e.controller-agent.dev/fixture": "event-triggers", ...labels } },
      type: "Opaque",
      stringData: { [key]: value },
    }),
  );
}

export async function deleteSecret(name: string): Promise<void> {
  await kubectl(["delete", "secret", name, "--ignore-not-found", "--wait=false"]).catch(() => undefined);
}

/**
 * Makes sure the example sources' Secrets exist, creating any missing one with
 * its fixed value. Never ROTATES an existing one: the gateway may cache a
 * verified secret, and a value changed under it would 401 the next delivery
 * for a reason no assertion names.
 */
export async function ensureEventSecrets(): Promise<void> {
  for (const s of [EVENT_SECRETS.slack, EVENT_SECRETS.ci, EVENT_SECRETS.genericHmac, EVENT_SECRETS.reply]) {
    const exists = (await kubectl(["get", "secret", s.name, "--ignore-not-found", "-o", "name"])).trim();
    if (!exists) await upsertSecret(s.name, s.key, s.value);
  }
}

export const githubWebhookSecret = () => secretValue(EVENT_SECRETS.github.name, EVENT_SECRETS.github.key);
export const slackSigningSecret = () => secretValue(EVENT_SECRETS.slack.name, EVENT_SECRETS.slack.key);
export const ciBearerToken = () => secretValue(EVENT_SECRETS.ci.name, EVENT_SECRETS.ci.key);
export const genericHmacSecret = () => secretValue(EVENT_SECRETS.genericHmac.name, EVENT_SECRETS.genericHmac.key);
export const replySigningSecret = () => secretValue(EVENT_SECRETS.reply.name, EVENT_SECRETS.reply.key);

// ── per-test CRs ─────────────────────────────────────────────────────────────

/** Label on every CR a spec creates, so `deleteEventFixtures` can sweep a whole file's worth. */
export const FIXTURE_LABEL = "e2e.controller-agent.dev/event-fixture";

/** A short, DNS-safe, per-process suffix for per-test CR names (EventSource names become URL paths and CronJob names). */
export function runSuffix(): string {
  return `${(Date.now() % 1_000_000).toString(36)}${randomUUID().slice(0, 4)}`;
}

export async function applyEventSource(name: string, spec: Record<string, unknown>, fixture: string): Promise<void> {
  await kubectlApplyStdin(
    JSON.stringify({
      apiVersion: "core.controller-agent.dev/v1alpha1",
      kind: "EventSource",
      metadata: { name, labels: { [FIXTURE_LABEL]: fixture } },
      spec,
    }),
  );
}

export async function applyEventTrigger(name: string, spec: Record<string, unknown>, fixture: string): Promise<void> {
  await kubectlApplyStdin(
    JSON.stringify({
      apiVersion: "core.controller-agent.dev/v1alpha1",
      kind: "EventTrigger",
      metadata: { name, labels: { [FIXTURE_LABEL]: fixture } },
      spec,
    }),
  );
}

/** Deletes every EventTrigger/EventSource/Secret a spec file labelled with `fixture`. */
export async function deleteEventFixtures(fixture: string): Promise<void> {
  for (const kind of ["eventtriggers", "eventsources", "secrets"]) {
    await kubectl(["delete", kind, "-l", `${FIXTURE_LABEL}=${fixture}`, "--ignore-not-found", "--wait=false"]).catch(
      () => undefined,
    );
  }
}

/** Applies a manifest file under e2e/manifests verbatim. */
export async function applyManifest(file: string): Promise<void> {
  const path = new URL(`../manifests/${file}`, import.meta.url).pathname;
  await kubectlApplyStdin(await readFile(path, "utf8"));
}

export async function deleteManifest(file: string): Promise<void> {
  const path = new URL(`../manifests/${file}`, import.meta.url).pathname;
  await kubectl(["delete", "-f", path, "--ignore-not-found", "--wait=false"]).catch(() => undefined);
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  observedGeneration?: number;
}

/** The `Ready` condition of an EventSource/EventTrigger, or undefined while none is set. */
export async function readyCondition(kind: "eventsource" | "eventtrigger", name: string): Promise<Condition | undefined> {
  const cr = await kubectlJson<{ metadata?: { generation?: number }; status?: { conditions?: Condition[] } }>([
    "get",
    kind,
    name,
  ]);
  const ready = cr.status?.conditions?.find((c) => c.type === "Ready");
  // A condition from an older generation describes a spec that no longer
  // exists; treat it as not-yet-reconciled rather than as the answer.
  if (ready?.observedGeneration !== undefined && cr.metadata?.generation !== undefined) {
    if (ready.observedGeneration < cr.metadata.generation) return undefined;
  }
  return ready;
}

/**
 * Waits until the CR's Ready condition has `status` (and `reason`, when given).
 * Returns the condition so the caller can assert on its message too.
 */
export async function waitForReady(
  kind: "eventsource" | "eventtrigger",
  name: string,
  status: "True" | "False",
  reason?: string,
  timeoutMs = 120_000,
): Promise<Condition> {
  return waitFor(
    `${kind}/${name} Ready=${status}${reason ? ` (${reason})` : ""}`,
    async () => {
      const c = await readyCondition(kind, name);
      if (!c || c.status !== status) return undefined;
      if (reason && c.reason !== reason) return undefined;
      return c;
    },
    { timeoutMs, intervalMs: 2_000 },
  );
}

// ── /invoke with an envelope (docs/event-triggers.md §5) ─────────────────────

const ORCHESTRATOR_SERVICE = "agent-orchestrator-invoke";
const ORCHESTRATOR_PORT = 8081;
const INVOKE_LOCAL_PORT = 18112;
/** values-e2e.yaml's `staticIdentities` token -- the same one integration-gateway relays with. */
const INVOKE_BEARER = "e2e-gateway-token";

/** The envelope, exactly as §2 defines it. */
export interface Envelope {
  source: string;
  kind: "webhook" | "cron";
  id: string;
  time: string;
  headers: Record<string, string>;
  body: unknown;
  sender: Record<string, unknown>;
  repository: string;
}

/** A webhook envelope with every §2 field present; override what the test is about. */
export function webhookEnvelope(source: string, body: unknown, overrides: Partial<Envelope> = {}): Envelope {
  return {
    source,
    kind: "webhook",
    id: `e2e-${randomUUID()}`,
    time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    headers: {},
    body,
    sender: {},
    repository: "",
    ...overrides,
  };
}

export interface InvokeEventResponse {
  status: number;
  body: {
    status?: string;
    id?: string;
    error?: string;
    trigger?: { name: string; sessionId: string; reply: Record<string, unknown> | null };
  };
}

/** `POST /invoke {event, session_id?}` straight at agent-orchestrator; the raw status and parsed body. */
export async function invokeEvent(envelope: Envelope, opts: { sessionId?: string } = {}): Promise<InvokeEventResponse> {
  return withPortForward(ORCHESTRATOR_SERVICE, ORCHESTRATOR_PORT, INVOKE_LOCAL_PORT, async (_baseUrl, forward) => {
    const res = await fetchThrough(forward, "/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INVOKE_BEARER}` },
      body: JSON.stringify({ event: envelope, ...(opts.sessionId ? { session_id: opts.sessionId } : {}) }),
    });
    const text = await res.text();
    let body: InvokeEventResponse["body"] = {};
    try {
      body = JSON.parse(text) as InvokeEventResponse["body"];
    } catch {
      body = { error: text };
    }
    return { status: res.status, body };
  });
}

/** Polls `GET /invoke/:id` to a terminal status. */
export async function waitForInvocation(id: string, timeoutMs = 300_000): Promise<{ status: string; result?: unknown; error?: string }> {
  return withPortForward(ORCHESTRATOR_SERVICE, ORCHESTRATOR_PORT, INVOKE_LOCAL_PORT, async (_baseUrl, forward) =>
    waitFor(
      `/invoke/${id} to reach a terminal status`,
      async () => {
        const res = await fetchThrough(forward, `/invoke/${id}`);
        if (!res.ok) return undefined;
        const record = (await res.json()) as { status: string; result?: unknown; error?: string };
        return record.status === "pending" ? undefined : record;
      },
      { timeoutMs, intervalMs: 3_000 },
    ),
  );
}

/**
 * Posts `envelope` until the orchestrator stops answering `ignored`, for a
 * trigger that was JUST applied: the orchestrator learns of it through a watch,
 * so the first post can race the informer. Stops at the first non-ignored
 * answer, so at most one turn is ever started.
 */
export async function invokeEventOnceMatched(
  envelope: () => Envelope,
  opts: { sessionId?: string; timeoutMs?: number } = {},
): Promise<InvokeEventResponse> {
  return waitFor(
    "the orchestrator to match the freshly applied EventTrigger",
    async () => {
      const r = await invokeEvent(envelope(), opts);
      return r.status === 200 && r.body.status === "ignored" ? undefined : r;
    },
    { timeoutMs: opts.timeoutMs ?? 90_000, intervalMs: 3_000 },
  );
}

/**
 * Blocks until the ORCHESTRATOR has loaded every EventTrigger applied before
 * this call -- the per-test triggers a spec just created, or the NotReady state
 * it just put one in.
 *
 * Ready=True on the CR says the controller is happy; it says nothing about
 * whether the orchestrator's informer has seen it, and a delivery that races
 * the informer is `ignored` for a reason no assertion names. So this applies a
 * PROBE trigger after everything else (on the `generic-hmac` source, matching
 * only its own id) whose params always fail to evaluate, and polls `/invoke`
 * with the probe's envelope until it answers 422. A watch delivers events in
 * resourceVersion order, so once the probe is visible everything applied before
 * it is too -- and a 422 starts no turn, so the poll is free.
 */
export async function waitForTriggersLoaded(fixture: string): Promise<void> {
  const probeId = runSuffix();
  const name = `e2e-probe-${probeId}`;
  await applyEventTrigger(
    name,
    {
      sourceRef: "generic-hmac",
      match: { cel: `has(body.e2eProbe) && body.e2eProbe == "${probeId}"` },
      params: { never: "body.e2eProbeMissing.deeper" },
      target: { orchestrator: {}, promptTemplate: "unreachable" },
    },
    fixture,
  );
  await waitForReady("eventtrigger", name, "True");
  await waitFor(
    "the orchestrator to load the probe EventTrigger (and so everything applied before it)",
    async () => {
      const r = await invokeEvent(webhookEnvelope("generic-hmac", { e2eProbe: probeId }));
      return r.status === 422 ? true : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 3_000 },
  );
}

// ── what a turn left behind ──────────────────────────────────────────────────

/** An AgentRun, narrowed to what the event specs assert on. */
export interface AgentRunDetail {
  name: string;
  createdAt: string;
  phase?: string;
  agentRef?: string;
  goal?: string;
  /** `spec.readOnly`; the launchers write it as `true` or omit it, so absent reads as false. */
  readOnly: boolean;
  params: Record<string, string>;
  jobName?: string;
  /**
   * `controller-agent.dev/session-id`. Written by the LangGraph launcher only
   * (the Temporal launcher sets no annotations), so assert on it only when
   * `deployedEngine() === "langgraph"`.
   */
  sessionAnnotation?: string;
}

/** Same widening as k8s.ts's agentRunsSince (second-granularity timestamps + host/node skew). */
const SINCE_SLACK_MS = 3_000;

export async function agentRunDetailsSince(since: Date): Promise<AgentRunDetail[]> {
  const cutoff = since.getTime() - SINCE_SLACK_MS;
  const list = await kubectlJson<{
    items: {
      metadata: { name: string; creationTimestamp: string; annotations?: Record<string, string> };
      spec?: { agentRef?: string; goal?: string; readOnly?: boolean; params?: Record<string, string> };
      status?: { phase?: string; jobName?: string };
    }[];
  }>(["get", "agentruns"]);
  return list.items
    .filter((i) => new Date(i.metadata.creationTimestamp).getTime() >= cutoff)
    .sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))
    .map((i) => ({
      name: i.metadata.name,
      createdAt: i.metadata.creationTimestamp,
      phase: i.status?.phase,
      agentRef: i.spec?.agentRef,
      goal: i.spec?.goal,
      readOnly: i.spec?.readOnly === true,
      params: i.spec?.params ?? {},
      jobName: i.status?.jobName,
      sessionAnnotation: i.metadata.annotations?.["controller-agent.dev/session-id"],
    }));
}

/**
 * The AgentRun an event for `number` launched, found by its PARAMS rather than
 * by recency: `spec.params` is contract (§6) on both engines, while the session
 * annotation is only written by the LangGraph launcher. Matching on the issue
 * number keeps a straggler from an earlier test from being mistaken for this one.
 */
export async function waitForAgentRunWithParam(
  since: Date,
  param: string,
  value: string,
  timeoutMs = 420_000,
): Promise<AgentRunDetail> {
  return waitFor(
    `an AgentRun with params.${param}=${value}`,
    async () => (await agentRunDetailsSince(since)).find((r) => r.params[param] === value),
    { timeoutMs },
  );
}

export async function waitForAgentRunTerminal(name: string, timeoutMs = 300_000): Promise<AgentRunDetail> {
  return waitFor(
    `AgentRun ${name} to reach a terminal phase`,
    async () => {
      const cr = await kubectlJson<{ status?: { phase?: string } }>(["get", "agentrun", name]);
      const phase = cr.status?.phase;
      if (phase !== "Succeeded" && phase !== "Failed") return undefined;
      return (await agentRunDetailsSince(new Date(0))).find((r) => r.name === name);
    },
    { timeoutMs },
  );
}

/**
 * Env vars on a run's Job whose VALUES are safe to read: the event-trigger
 * flags, never a credential. An allowlist, not a filter, so a future secret
 * env var can never be returned by accident.
 */
const NON_SECRET_RUN_ENV = new Set(["AGENT_READ_ONLY", "AGENT_PARAMS", "TOOL_READ_ONLY"]);

/** `{name: value}` for the allowlisted env on a Job; absent names are absent keys. Jobs carry a TTL, so read early. */
export async function runJobFlags(jobName: string): Promise<Record<string, string>> {
  const job = await kubectlJson<{
    spec: { template: { spec: { containers: { env?: { name: string; value?: string }[] }[] } } };
  }>(["get", "job", jobName]);
  const out: Record<string, string> = {};
  for (const e of job.spec.template.spec.containers[0]?.env ?? []) {
    if (NON_SECRET_RUN_ENV.has(e.name) && e.value !== undefined) out[e.name] = e.value;
  }
  return out;
}

export interface ToolRunDetail {
  name: string;
  createdAt: string;
  toolRef?: string;
  readOnly: boolean;
  args: string[];
  phase?: string;
}

export async function toolRunDetailsSince(since: Date): Promise<ToolRunDetail[]> {
  const cutoff = since.getTime() - SINCE_SLACK_MS;
  const list = await kubectlJson<{
    items: {
      metadata: { name: string; creationTimestamp: string };
      spec?: { toolRef?: string; readOnly?: boolean; args?: string[] };
      status?: { phase?: string };
    }[];
  }>(["get", "toolruns"]);
  return list.items
    .filter((i) => new Date(i.metadata.creationTimestamp).getTime() >= cutoff)
    .map((i) => ({
      name: i.metadata.name,
      createdAt: i.metadata.creationTimestamp,
      toolRef: i.spec?.toolRef,
      readOnly: i.spec?.readOnly === true,
      args: i.spec?.args ?? [],
      phase: i.status?.phase,
    }));
}

/** Deletes ToolRuns created since `since` (the controller reclaims Jobs, never the CRs). */
export async function cleanupToolRunsSince(since: Date): Promise<void> {
  for (const run of await toolRunDetailsSince(since)) {
    await kubectl(["delete", "toolrun", run.name, "--ignore-not-found", "--wait=false"]).catch(() => undefined);
  }
}

// ── stub-agent's reply line (apps/stub-agent/src/reply.ts runFlagsLine) ─────

/** `readOnly=<bool> params=<json>` parsed out of a stub reply, or undefined if the line is absent. */
export function parseRunFlagsLine(text: string): { readOnly: boolean; params: Record<string, string> } | undefined {
  const m = /^readOnly=(true|false) params=(\{.*\})\s*$/m.exec(text);
  if (!m) return undefined;
  return { readOnly: m[1] === "true", params: JSON.parse(m[2] as string) as Record<string, string> };
}

/** What `runFlagsLine` would print for `params` -- compact JSON, keys sorted. */
export function expectedParamsJson(params: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

// ── GitHub side-effects, as fake-github recorded them ────────────────────────

export interface IssueActivity {
  /** POSTed comments on the issue, in the order fake-github received them. */
  comments: (RecordedRequest & { text: string })[];
  /** DELETEs against the issue's labels endpoint (the trigger-label removal). */
  labelDeletes: RecordedRequest[];
}

export async function issueActivity(owner: string, repo: string, number: number): Promise<IssueActivity> {
  const all = await fakeGithubRequests();
  const base = `/repos/${owner}/${repo}/issues/${number}`;
  return {
    comments: all
      .filter((r) => r.method === "POST" && r.path === `${base}/comments`)
      .map((r) => {
        let text = "";
        try {
          text = String((JSON.parse(r.body ?? "{}") as { body?: unknown }).body ?? "");
        } catch {
          text = r.body ?? "";
        }
        return { ...r, text };
      }),
    labelDeletes: all.filter((r) => r.method === "DELETE" && r.path.startsWith(`${base}/labels/`)),
  };
}

/** Marker every stub reply carries (apps/stub-agent/src/reply.ts STUB_REPLY_MARKER). */
export const STUB_REPLY_MARKER = "stub-agent-reply";

/** The ack text the example GitHub triggers post (charts/community-components eventtrigger-github-*.yaml). */
export const EXAMPLE_ACK_TEXT = "Starting work on this now.";
