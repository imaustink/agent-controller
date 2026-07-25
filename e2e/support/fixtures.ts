import { kubectl, waitFor, withPortForward } from "./k8s.js";

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

/** Applies the fake-github manifest and waits for it to be ready. Idempotent. */
export async function ensureFakeGithub(): Promise<void> {
  await kubectl(["apply", "-f", new URL("../manifests/fake-github.yaml", import.meta.url).pathname]);
  await waitFor(
    "fake-github to become ready",
    async () => {
      const out = await kubectl(["get", "deploy", "fake-github", "-o", "jsonpath={.status.readyReplicas}"]);
      return out.trim() === "1" ? true : undefined;
    },
    { timeoutMs: 120_000 },
  );
}

export async function fakeGithubRequests(): Promise<RecordedRequest[]> {
  return withPortForward("fake-github", 80, FAKE_GITHUB_PORT, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/_e2e/requests`);
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
  await withPortForward("fake-github", 80, FAKE_GITHUB_PORT, async (baseUrl) => {
    await fetch(`${baseUrl}/_e2e/reset`, { method: "POST" });
  });
}
