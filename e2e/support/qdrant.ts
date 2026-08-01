import { fetchThrough, openPortForward, withPortForward, type PortForward } from "./k8s.js";

/**
 * Reads the orchestrator's REAL Qdrant, so a spec can assert on which
 * collection a turn wrote to.
 *
 * This exists because caller-supplied tools (docs/adr/0035) make a claim that
 * is invisible to every unit test: a consumer's ephemeral function definitions
 * are indexed into their OWN collection and the tool/skill/agent catalogs are
 * never touched. `apps/agent-orchestrator`'s tests mock the Qdrant client
 * outright, so they can only prove which method the code MEANT to call — not
 * which collection ended up with points in it, and not that Qdrant accepted the
 * filter DSL at all. Both are exactly the kind of cross-component wiring this
 * suite exists for.
 *
 * Read-only on purpose. Nothing here creates or deletes a collection: the
 * collections under observation are the deployment's own, and a helper that
 * could drop one would eventually drop the catalog.
 */

/** Bundled qdrant subchart's Service (see agent-orchestrator's `qdrantUrl` helper). */
const QDRANT_SERVICE = "agent-controller-qdrant";
const QDRANT_PORT = 6333;
const LOCAL_PORT = 18063;

/** The orchestrator's collection names, matching values-e2e.yaml / the chart defaults. */
export const COLLECTIONS = {
  tools: "tools",
  skills: "skills",
  agents: "agents",
  callerTools: "caller_tools",
} as const;

/** Runs `body` against a port-forwarded Qdrant HTTP API. */
export async function withQdrant<T>(body: (baseUrl: string) => Promise<T>): Promise<T> {
  return withPortForward(QDRANT_SERVICE, QDRANT_PORT, LOCAL_PORT, body);
}

/**
 * A Qdrant forward the CALLER closes — for a spec that talks to Qdrant across
 * several tests and shouldn't re-spawn kubectl for each one.
 *
 * Uses a different local port than {@link withQdrant} on purpose: a spec holding
 * this open while some helper reaches for `withQdrant` would otherwise collide on
 * the same port and fail to bind, which surfaces as an unrelated connection error.
 */
export async function openQdrant(): Promise<PortForward> {
  return openPortForward(QDRANT_SERVICE, QDRANT_PORT, LOCAL_PORT + 1);
}

async function qdrantGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetchThrough({ baseUrl }, path);
  if (!res.ok) throw new Error(`e2e: qdrant GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Names of every collection that currently exists. */
export async function listCollections(baseUrl: string): Promise<string[]> {
  const body = await qdrantGet<{ result: { collections: { name: string }[] } }>(baseUrl, "/collections");
  return body.result.collections.map((c) => c.name);
}

/**
 * Point count for one collection, or `undefined` when the collection does not
 * exist.
 *
 * `undefined` rather than a throw so a spec can distinguish "the collection was
 * never created" from "it exists and is empty" — those mean opposite things
 * about whether the feature is wired up.
 */
export async function pointCount(baseUrl: string, collection: string): Promise<number | undefined> {
  const res = await fetchThrough({ baseUrl }, `/collections/${collection}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`e2e: qdrant collection ${collection} lookup failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result: { points_count?: number } };
  return body.result.points_count ?? 0;
}

/** Point counts for every collection the orchestrator uses, in one port-forward. */
export async function allPointCounts(): Promise<Record<keyof typeof COLLECTIONS, number | undefined>> {
  return withQdrant(async (baseUrl) => ({
    tools: await pointCount(baseUrl, COLLECTIONS.tools),
    skills: await pointCount(baseUrl, COLLECTIONS.skills),
    agents: await pointCount(baseUrl, COLLECTIONS.agents),
    callerTools: await pointCount(baseUrl, COLLECTIONS.callerTools),
  }));
}

/**
 * The `name` payload field of every point in a collection.
 *
 * Payload only, never vectors: a spec asserts on WHICH definitions are indexed,
 * and pulling 1536-dimension vectors across a port-forward to answer that is
 * pure cost.
 */
export async function payloadNames(baseUrl: string, collection: string, limit = 200): Promise<string[]> {
  const res = await fetchThrough({ baseUrl }, `/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, with_payload: true, with_vector: false }),
  });
  if (!res.ok) throw new Error(`e2e: qdrant scroll ${collection} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result: { points: { payload?: { name?: string } }[] } };
  return body.result.points.map((p) => p.payload?.name ?? "").filter((n) => n !== "");
}
