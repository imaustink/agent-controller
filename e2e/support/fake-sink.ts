import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fetchThrough, kubectl, kubectlApplyStdin, waitFor, withPortForward } from "./k8s.js";

/**
 * The in-cluster HTTP recorder `reply.http` side-effects post to
 * (manifests/fake-sink.yaml). See that file for what it records and why the
 * body is kept verbatim.
 */

const FAKE_SINK_LOCAL_PORT = 18111;

/** In-cluster base URL -- what values-e2e.yaml and per-test triggers put in `reply.http.url`. */
export const FAKE_SINK_URL = "http://fake-sink.controller-agent.svc.cluster.local";

/** The marker fake-sink's `/page.html` carries (must match the manifest's PAGE_MARKER). */
export const FAKE_SINK_PAGE_MARKER = "E2E-FAKE-SINK-PAGE-7f3c";

/** Where each example trigger's reply lands (values-e2e.yaml), and the prefix per-test triggers use. */
export const replyPath = (triggerName: string) => `/reply/${triggerName}`;
export const replyUrl = (triggerName: string) => `${FAKE_SINK_URL}${replyPath(triggerName)}`;

export interface SinkRequest {
  method: string;
  path: string;
  query: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The raw body string, exactly as received -- what a signature is over. */
  body: string | null;
  at: string;
}

/** The documented `reply.http` body (docs/event-triggers.md §7 / the gateway's reply adapter). */
export interface HttpReplyBody {
  trigger: string;
  sessionId: string;
  status: "succeeded" | "failed";
  result?: unknown;
  error?: string;
}

/**
 * Applies the manifest with a checksum of its own contents in the pod template,
 * so an edited script rolls the pod (same technique and reason as
 * ensureFakeGithub; see e2e/README.md). Idempotent.
 */
export async function ensureFakeSink(): Promise<void> {
  const manifestPath = new URL("../manifests/fake-sink.yaml", import.meta.url).pathname;
  const template = await readFile(manifestPath, "utf8");
  const checksum = createHash("sha256").update(template).digest("hex").slice(0, 16);
  const manifest = template.replace("REPLACED_AT_APPLY", checksum);
  if (manifest === template) throw new Error(`e2e: ${manifestPath} lost its REPLACED_AT_APPLY placeholder`);
  await kubectlApplyStdin(manifest);
  await kubectl(["rollout", "status", "deploy/fake-sink", "--timeout=120s"]);
}

export async function fakeSinkRequests(): Promise<SinkRequest[]> {
  return withPortForward("fake-sink", 80, FAKE_SINK_LOCAL_PORT, async (_baseUrl, forward) => {
    const res = await fetchThrough(forward, "/_e2e/requests");
    return (await res.json()) as SinkRequest[];
  });
}

/** Clears the recording. Called in beforeAll, never afterAll, so a crashed run leaves its evidence. */
export async function resetFakeSink(): Promise<void> {
  await ensureFakeSink();
  await withPortForward("fake-sink", 80, FAKE_SINK_LOCAL_PORT, async (_baseUrl, forward) => {
    await fetchThrough(forward, "/_e2e/reset", { method: "POST" });
  });
}

/**
 * Waits for a POST to `path` whose parsed body satisfies `match` (default: any),
 * returning the request and its parsed body.
 */
export async function waitForSinkPost(
  path: string,
  match: (body: HttpReplyBody) => boolean = () => true,
  timeoutMs = 420_000,
): Promise<{ request: SinkRequest; body: HttpReplyBody }> {
  return waitFor(
    `a reply POSTed to fake-sink ${path}`,
    async () => {
      for (const request of (await fakeSinkRequests()).filter((r) => r.method === "POST" && r.path === path)) {
        let body: HttpReplyBody;
        try {
          body = JSON.parse(request.body ?? "") as HttpReplyBody;
        } catch {
          continue;
        }
        if (match(body)) return { request, body };
      }
      return undefined;
    },
    { timeoutMs, intervalMs: 3_000 },
  );
}

/**
 * Whether `x-event-signature` is `sha256=<hex hmac(secret, raw body)>`, in
 * constant time. Recomputed over the RECORDED raw body -- a gateway that signed
 * one serialization and sent another fails here, which is the point.
 */
export function hasValidEventSignature(request: SinkRequest, secret: string): boolean {
  const header = request.headers["x-event-signature"];
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(request.body ?? "").digest("hex"));
  const actual = Buffer.from(header.slice("sha256=".length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
