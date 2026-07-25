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
 * Polls `probe` until it returns a non-null/undefined value, or the timeout
 * elapses. Returns what the probe returned so callers can assert on it.
 *
 * Everything asynchronous in this system is eventually-consistent across at
 * least two processes (a webhook lands, the gateway relays, the orchestrator
 * runs a graph, a controller reconciles a CR, a Job schedules), so a bare
 * assertion after a fixed sleep is either flaky or slow. `describe` is
 * included in the timeout message because a bare "timed out" tells you
 * nothing about which of those hops stalled.
 */
export async function waitFor<T>(
  describe: string,
  probe: () => Promise<T | undefined | null>,
  { timeoutMs = 120_000, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null) return value;
    } catch (err) {
      // Probes routinely throw early on (a CR that doesn't exist yet makes
      // kubectl exit non-zero). Hold the last one to report if we time out --
      // a persistent error is far more useful than "condition never met".
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `e2e: timed out after ${timeoutMs}ms waiting for ${describe}` +
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

/** Port-forwards a Service for the duration of `body`, then tears it down. */
export async function withPortForward<T>(
  service: string,
  remotePort: number,
  localPort: number,
  body: (baseUrl: string) => Promise<T>,
): Promise<T> {
  requireMinikubeContext();
  const child = execFile("kubectl", ["-n", NAMESPACE, "port-forward", `svc/${service}`, `${localPort}:${remotePort}`]);
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
    return await body(`http://127.0.0.1:${localPort}`);
  } finally {
    child.kill();
  }
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
