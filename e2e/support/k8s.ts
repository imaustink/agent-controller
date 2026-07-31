import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireMinikubeContext } from "./guard.js";

const exec = promisify(execFile);

export const NAMESPACE = "controller-agent";

/**
 * Runs kubectl and returns stdout. Re-checks the context on every call rather
 * than trusting that the module-scope guard ran: a spec that forgot to import
 * the guard would otherwise reach the cluster through this helper.
 */
export async function kubectl(args: string[]): Promise<string> {
  requireMinikubeContext();
  const { stdout } = await exec("kubectl", ["-n", NAMESPACE, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function kubectlJson<T = unknown>(args: string[]): Promise<T> {
  return JSON.parse(await kubectl([...args, "-o", "json"])) as T;
}

/**
 * `kubectl apply -f -` with `manifest` on stdin.
 *
 * Needed because the e2e manifests are templated before they are applied (see
 * ensureFakeGithub's checksum substitution) and writing the rendered YAML to a
 * temp file just to hand kubectl a path adds a cleanup path that can fail.
 */
export async function kubectlApplyStdin(manifest: string): Promise<string> {
  requireMinikubeContext();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "kubectl",
      ["-n", NAMESPACE, "apply", "-f", "-"],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`kubectl apply -f - failed: ${stderr || err.message}`)) : resolve(stdout)),
    );
    child.stdin?.end(manifest);
  });
}

/**
 * Upper bound on a SINGLE probe attempt. Generous — a `kubectl get` on a loaded
 * minikube can take seconds — but finite, for the reason in {@link waitFor}.
 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Races `promise` against `ms`, resolving to `TIMED_OUT` rather than throwing.
 *
 * A distinct sentinel instead of a rejection so {@link waitFor} can tell "this
 * attempt hung" apart from "this attempt failed", and report the difference.
 */
const TIMED_OUT = Symbol("probe-timed-out");
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Polls `probe` until it returns a non-null/undefined value, or the timeout
 * elapses. Returns what the probe returned so callers can assert on it.
 *
 * Everything asynchronous in this system is eventually-consistent across at
 * least two processes (a webhook lands, the gateway relays, the orchestrator
 * runs a graph, a controller reconciles a CR, a Job schedules), so a bare
 * assertion after a fixed sleep is either flaky or slow. `describe` is
 * included in the timeout message because a bare "timed out" tells you
 * nothing about which of those hops stalled.
 *
 * **Every probe attempt is bounded** (`PROBE_TIMEOUT_MS`), and that is not
 * belt-and-braces. This used to `await probe()` unbounded, which meant a probe
 * that never settled made `timeoutMs` UNREACHABLE — the loop simply stopped,
 * forever, without ever re-checking the deadline. It is reachable: several probes
 * `fetch` through a `kubectl port-forward`, and a forward dropped by a busy
 * apiserver leaves a socket that never answers and a fetch with nothing to time
 * it out. Observed directly: a resilience run sat at 0% CPU for eight minutes,
 * no kubectl processes, no output, until vitest's own per-test timeout killed it
 * — reported as "the test timed out" with nothing about which hop stalled, which
 * is exactly the diagnosis this function exists to provide.
 *
 * A hung attempt is counted and reported rather than swallowed, because "12
 * attempts, all hung" and "12 attempts, condition never true" call for
 * completely different fixes.
 */
export async function waitFor<T>(
  describe: string,
  probe: () => Promise<T | undefined | null>,
  {
    timeoutMs = 120_000,
    intervalMs = 2_000,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
  }: { timeoutMs?: number; intervalMs?: number; probeTimeoutMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let hungAttempts = 0;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      // Bounded by whichever is sooner: the per-probe ceiling or what remains of
      // the overall budget -- so a hung probe can never overrun `timeoutMs` by
      // more than the rounding.
      const remaining = Math.max(0, deadline - Date.now());
      const value = await withDeadline(probe(), Math.min(probeTimeoutMs, remaining));
      if (value === TIMED_OUT) {
        hungAttempts++;
      } else if (value !== undefined && value !== null) {
        return value;
      }
    } catch (err) {
      // Probes routinely throw early on (a CR that doesn't exist yet makes
      // kubectl exit non-zero). Hold the last one to report if we time out --
      // a persistent error is far more useful than "condition never met".
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `e2e: timed out after ${timeoutMs}ms waiting for ${describe} (${attempts} attempts` +
      (hungAttempts > 0 ? `, ${hungAttempts} of them hung and were abandoned` : "") +
      ")" +
      (lastError ? `; last probe error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""),
  );
}

/** AgentRuns created since `since`, newest first -- the handle for "did this trigger actually launch an agent". */
export async function agentRunsSince(since: Date): Promise<{ name: string; phase?: string }[]> {
  const list = await kubectlJson<{
    items: { metadata: { name: string; creationTimestamp: string }; status?: { phase?: string } }[];
  }>(["get", "agentruns"]);
  return list.items
    .filter((i) => new Date(i.metadata.creationTimestamp) >= since)
    .sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))
    .map((i) => ({ name: i.metadata.name, phase: i.status?.phase }));
}

/**
 * Env var NAMES on a launched AgentRun's Job, in order.
 *
 * Names only, never values: these are live credentials, and a test that
 * printed one on failure would leak it into CI logs. Order is returned
 * because duplicate env names are legal in Kubernetes and the LAST one wins --
 * a static `secretEnv` shadowing a per-run identity override is a real
 * failure mode this is meant to catch.
 */
export async function jobEnvNames(agentRunName: string): Promise<string[]> {
  const job = await kubectlJson<{
    spec: { template: { spec: { containers: { env?: { name: string }[] }[] } } };
  }>(["get", "job", `agentrun-${agentRunName}`]);
  return (job.spec.template.spec.containers[0]?.env ?? []).map((e) => e.name);
}

/**
 * Port-forwards a Service and returns the base URL plus its teardown.
 *
 * The caller owns the lifetime, which {@link withPortForward} does not allow.
 * Needed by a spec that makes many small round trips to one service across
 * several tests: each `withPortForward` spawns a kubectl process and re-pays the
 * readiness poll, so per-call forwarding turns a handful of HTTP requests into
 * seconds of process churn.
 *
 * Prefer `withPortForward` whenever the scope really is one function — a returned
 * `close` is a leak waiting to happen, and a leaked forward holds a local port
 * that the next spec's forward then fails to bind.
 */
export async function openPortForward(
  service: string,
  remotePort: number,
  localPort: number,
): Promise<PortForward> {
  requireMinikubeContext();
  const child = execFile("kubectl", ["-n", NAMESPACE, "port-forward", `svc/${service}`, `${localPort}:${remotePort}`]);
  // A forward that dies takes its listener with it, and a `fetch` already issued
  // against it can then wait forever on a socket nobody will answer -- the exact
  // shape that hung a resilience run for eight silent minutes. Recording the exit
  // lets `fetchThrough` below turn that into an immediate, named failure.
  let exited: string | undefined;
  child.on("exit", (code, signal) => {
    exited = `kubectl port-forward svc/${service} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`;
  });
  try {
    // kubectl prints "Forwarding from ..." once the listener is up; poll the
    // socket instead of trusting a fixed sleep, which is the usual source of
    // "connection refused" flakes on a loaded machine.
    await waitFor(
      `port-forward to ${service}:${remotePort} to accept connections`,
      async () => {
        try {
          await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(1_000) });
          return true;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
  } catch (err) {
    // Never leave the child running when we never became ready -- otherwise a
    // failed setup silently holds the local port for the rest of the run.
    child.kill();
    throw new Error(
      `e2e: port-forward to ${service}:${remotePort} never became ready` +
        (exited ? ` (${exited})` : "") +
        `: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    baseUrl: `http://127.0.0.1:${localPort}`,
    close: () => child.kill(),
    hasExited: () => exited,
  };
}

/** An open port-forward, plus the means to notice it died. */
export interface PortForward {
  baseUrl: string;
  close: () => void;
  /** A description of the forward's exit, or `undefined` while it is still up. */
  hasExited: () => string | undefined;
}

/** Default ceiling for a single HTTP request made through a port-forward. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * `fetch` through a port-forward, bounded and with a diagnosable failure.
 *
 * Every HTTP call this suite makes to an in-cluster service should go through
 * here rather than calling `fetch` directly. Two reasons, both learned from a run
 * that hung for eight minutes with no output, no CPU and no processes:
 *
 * - **A bare `fetch` has no timeout.** Node's fetch waits indefinitely, so a
 *   dropped forward is indistinguishable from a slow service and never fails.
 * - **The interesting fact is why.** "The forward died" and "the service is not
 *   answering" have different fixes, so the error says which, using the exit the
 *   forward recorded.
 */
export async function fetchThrough(
  forward: PortForward | { baseUrl: string },
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...rest } = init;
  const hasExited = "hasExited" in forward ? forward.hasExited : () => undefined;
  const exitedBefore = hasExited();
  if (exitedBefore) {
    throw new Error(`e2e: refusing to request ${path} -- the port-forward is already gone (${exitedBefore})`);
  }
  try {
    return await fetch(`${forward.baseUrl}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const exitedDuring = hasExited();
    throw new Error(
      `e2e: request to ${path} failed after up to ${timeoutMs}ms` +
        (exitedDuring ? ` -- the port-forward died mid-request (${exitedDuring})` : "") +
        `: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Port-forwards a Service for the duration of `body`, then tears it down.
 *
 * `body` gets the base URL *and* the forward itself. The second argument is what
 * lets a caller use {@link fetchThrough} and so find out that a request failed
 * because the forward died rather than because the service misbehaved — pass it
 * along rather than closing over `baseUrl` alone.
 */
export async function withPortForward<T>(
  service: string,
  remotePort: number,
  localPort: number,
  body: (baseUrl: string, forward: PortForward) => Promise<T>,
): Promise<T> {
  const forward = await openPortForward(service, remotePort, localPort);
  try {
    return await body(forward.baseUrl, forward);
  } finally {
    forward.close();
  }
}

/**
 * The Agent a launched AgentRun is for (`spec.agentRef`).
 *
 * Needed by any spec whose turn reaches an agent through the PLANNER rather
 * than an IntegrationRoute: a wrong selection otherwise fails as a bare
 * assertion about missing env vars, or as a wait that times out, with nothing
 * saying which agent actually ran.
 */
export async function agentRunAgentRef(agentRunName: string): Promise<string | undefined> {
  const cr = await kubectlJson<{ spec?: { agentRef?: string } }>(["get", "agentrun", agentRunName]);
  return cr.spec?.agentRef;
}

/**
 * `spec.secretEnv` entry NAMES on an AgentRun CR.
 *
 * The CR is agent-orchestrator's OUTPUT -- what the authorization pre-flight
 * decided to inject. Asserting here rather than on the rendered Job keeps this
 * scoped to the component under test: turning `spec.secretEnv` into container
 * env is core-controller's job, with its own tests, and conflating the two
 * makes an orchestrator spec fail for a controller reason.
 *
 * Names only, never values -- same discipline as {@link jobEnvNames}.
 */
export async function agentRunSecretEnvNames(agentRunName: string): Promise<string[]> {
  const cr = await kubectlJson<{ spec?: { secretEnv?: { name: string }[] } }>(["get", "agentrun", agentRunName]);
  return (cr.spec?.secretEnv ?? []).map((e) => e.name);
}

/**
 * Deletes AgentRun CRs created at or after `since`, plus the Kubernetes
 * Secrets each one owns.
 *
 * Nothing else deletes them. The controller sets a TTL on the Job it creates,
 * so Jobs disappear -- but the AgentRun CR and its `<run>-identity` Secret
 * persist indefinitely. A suite that triggers a handful of runs per execution
 * therefore leaves permanent residue: 50 CRs and 26 Secrets had accumulated
 * here before this existed.
 *
 * That residue is not merely untidy. Cross-run state is what made these specs
 * flaky in the first place (a reused issue number inherits its predecessor's
 * session), and `agentRunsSince` has to list and filter every CR ever created,
 * which grows without bound.
 *
 * Deleting the CR should cascade to the Secret via its ownerReference; the
 * explicit sweep is a backstop for any Secret whose owner was already gone.
 */
export async function cleanupAgentRunsSince(since: Date): Promise<number> {
  const runs = await agentRunsSince(since);
  for (const run of runs) {
    // --wait=false: teardown must not block the suite on finalizers, and a
    // failure here should never fail a test that already passed.
    await kubectl(["delete", "agentrun", run.name, "--wait=false", "--ignore-not-found"]).catch(() => undefined);
    await kubectl(["delete", "secret", `${run.name}-identity`, "--wait=false", "--ignore-not-found"]).catch(
      () => undefined,
    );
  }
  return runs.length;
}
