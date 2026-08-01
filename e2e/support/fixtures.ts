import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fetchThrough, kubectl, kubectlApplyStdin, withPortForward } from "./k8s.js";

const FAKE_GITHUB_PORT = 18081;

export interface RecordedRequest {
  method: string;
  path: string;
  body: string | null;
  at: string;
  /** Present only on responses fake-github rejected as unstubbed. */
  status?: number;
}

/**
 * The gateway's webhook HMAC secret, read from the cluster rather than
 * hardcoded — the test has to sign with whatever the deployment is actually
 * verifying against, or every webhook 401s for a reason that looks like a
 * gateway bug.
 *
 * This is the one place a secret VALUE is read, and it is unavoidable: signing
 * is the whole point. It is never logged and never asserted on.
 */
export async function webhookSecret(): Promise<string> {
  const b64 = (
    await kubectl([
      "get",
      "secret",
      "e2e-integration-gateway-secrets",
      "-o",
      "jsonpath={.data.GITHUB_WEBHOOK_SECRET}",
    ])
  ).trim();
  if (!b64) throw new Error("e2e: GITHUB_WEBHOOK_SECRET not found on e2e-integration-gateway-secrets (run e2e/scripts/bootstrap-secrets.sh)");
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Applies the fake-github manifest and waits for the pod SERVING THAT VERSION
 * of the script to be ready. Idempotent, and a no-op rollout when the manifest
 * hasn't changed.
 *
 * The subtlety is the mounted ConfigMap. Applying an edited script updates the
 * ConfigMap, and the kubelet eventually updates the mounted file -- but the
 * `node` process read it once at startup and never re-reads it, so the pod goes
 * on serving the previous script indefinitely while every readiness signal says
 * Ready. That is how a readiness-probe fix to this file appeared not to take
 * effect at all.
 *
 * `kubectl rollout restart` after the apply is the usual reflex and races: it
 * can start the new pod before the ConfigMap write it was meant to pick up has
 * landed, so the restart is wasted and the stale script survives it. Instead
 * the manifest carries a checksum annotation on the pod template, substituted
 * here, so the script's content is PART of the pod spec: a changed script
 * changes the template and the Deployment rolls by itself, atomically with the
 * apply. `rollout status` then blocks on the new generation specifically --
 * unlike a readyReplicas poll, which the outgoing pod satisfies immediately.
 */
export async function ensureFakeGithub(): Promise<void> {
  const manifestPath = new URL("../manifests/fake-github.yaml", import.meta.url).pathname;
  const template = await readFile(manifestPath, "utf8");
  // Hashed with the placeholder still in it, so the value is a pure function of
  // the file on disk and re-applying an unchanged file is a genuine no-op.
  const checksum = createHash("sha256").update(template).digest("hex").slice(0, 16);
  const manifest = template.replace("REPLACED_AT_APPLY", checksum);
  if (manifest === template) {
    throw new Error(`e2e: ${manifestPath} is missing the REPLACED_AT_APPLY checksum placeholder; a script edit would not roll the pod`);
  }

  await kubectlApplyStdin(manifest);
  // Blocks until the pod matching the applied template is Available. Bounded
  // rather than indefinite so a genuinely broken script (a syntax error, say)
  // fails here with kubectl's own diagnosis instead of inside a spec's waitFor.
  await kubectl(["rollout", "status", "deploy/fake-github", "--timeout=120s"]);
}

/**
 * Every request fake-github has recorded.
 *
 * Uses `fetchThrough` rather than a bare `fetch` for a reason with a scar: this
 * is polled repeatedly by `commentOn`-style waits, and Node's fetch has no
 * default timeout, so a port-forward dropped mid-poll left this awaiting a socket
 * nobody would ever answer. `waitFor` was then stuck inside a probe that could not
 * finish and never re-checked its own deadline — a resilience run sat silent for
 * eight minutes on exactly this.
 */
export async function fakeGithubRequests(): Promise<RecordedRequest[]> {
  return withPortForward("fake-github", 80, FAKE_GITHUB_PORT, async (_baseUrl, forward) => {
    const res = await fetchThrough(forward, "/_e2e/requests");
    return (await res.json()) as RecordedRequest[];
  });
}

/**
 * Clears fake-github's recorded requests so a test asserts only on traffic it
 * caused. Called in `beforeAll` rather than `afterAll`: a run that crashes
 * mid-test should leave its evidence in place for inspection.
 */
export async function resetFakeGithub(): Promise<void> {
  await ensureFakeGithub();
  await withPortForward("fake-github", 80, FAKE_GITHUB_PORT, async (_baseUrl, forward) => {
    await fetchThrough(forward, "/_e2e/reset", { method: "POST" });
  });
}
