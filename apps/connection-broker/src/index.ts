/**
 * The connection-broker process.
 *
 * Two jobs in one Deployment, both of which need the same third-party
 * credentials and neither of which may hold cluster RBAC (ADR 0038 §3):
 *
 *   - Serves the HTTP API: per-user authorization probes for retrieval, and
 *     listing/fetch for ingestion.
 *   - Runs each Connection's reconcile pass on its own schedule.
 */
import * as k8s from "@kubernetes/client-node";
import { createBrokerServer } from "./server.js";
import { CrdConnectionRegistry } from "./crd-connection-registry.js";
import { collectionOf, reconcileIntervalMs, type ConnectionCustomResource } from "./connection-resource.js";
import { EMBEDDING_DIMENSIONS, OpenAIEmbedder } from "./embedder.js";
import { QdrantCorpusWriter } from "./sync/corpus-writer.js";
import { HttpResourceSource } from "./sync/http-source.js";
import { SyncScheduler } from "./sync/scheduler.js";
import { QdrantHttpClient } from "./sync/qdrant-client.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at startup rather than on the first request. A broker running
    // without its orchestrator token would accept nothing and look like a
    // networking problem.
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const namespace = process.env.NAMESPACE ?? "default";
  const group = process.env.CRD_GROUP ?? "core.controller-agent.dev";
  const version = process.env.CRD_VERSION ?? "v1alpha1";
  const port = Number(process.env.PORT ?? 8080);

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();

  const registry = CrdConnectionRegistry.fromKubeConfig(
    namespace,
    group,
    version,
    kubeConfig,
    (connection, err) => {
      // Reported, never fatal: one malformed Connection must not stop the
      // broker serving every other client's.
      console.error(`connection ${connection} could not be bound:`, err);
    },
  );

  await registry.loadAll();
  registry.watch();
  console.log(`bound ${registry.list().length} connection(s) in ${namespace}`);

  // Sync tokens are per connection, so a leaked one reaches one client's source
  // rather than every client's. They arrive as SYNC_TOKEN_<CONNECTION>.
  const syncTokens = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^SYNC_TOKEN_(.+)$/.exec(key);
    if (match && value) syncTokens.set(match[1]!.toLowerCase().replace(/_/g, "-"), value);
  }

  // Webhook signing secrets, one per connection, as WEBHOOK_SECRET_<CONNECTION>.
  // Separate from the sync tokens on purpose: this one is shared with a third
  // party, and a secret the provider also holds must not also be the thing that
  // authorizes our own worker.
  const webhookSecrets = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^WEBHOOK_SECRET_(.+)$/.exec(key);
    if (match && value) webhookSecrets.set(match[1]!.toLowerCase().replace(/_/g, "-"), value);
  }

  // Declared before the server so the webhook route can reach it, and left
  // undefined when this deployment does not index — in which case the route
  // reports not-found rather than accepting notifications it cannot act on.
  let scheduler: SyncScheduler | undefined;

  const server = createBrokerServer({
    auth: { orchestratorToken: required("ORCHESTRATOR_TOKEN"), syncTokens },
    registry,
    webhooks: {
      secretFor: (connection) => webhookSecrets.get(connection),
      onChange: (connection, sourceIds) => {
        // Fire and forget: a provider's delivery must be acknowledged promptly
        // or it gets retried and eventually the endpoint gets disabled. The
        // pass reports through the scheduler's own callbacks.
        void scheduler?.onWebhook(connection, sourceIds);
      },
    },
  });
  server.listen(port, () => console.log(`connection-broker listening on ${port}`));

  scheduler = startSync(registry, syncTokens, port);

  const shutdown = () => {
    scheduler?.stop();
    registry.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Wires the reconcile loop, if this deployment is configured to run one.
 *
 * Absent OPENAI_API_KEY or QDRANT_URL means "serve only": the broker still
 * answers probes against corpora somebody else populated. That is a real
 * arrangement rather than a misconfiguration, so it starts rather than exits —
 * but it says so, because a broker silently indexing nothing looks exactly like
 * a broker whose sources are empty.
 */
function startSync(
  registry: CrdConnectionRegistry,
  syncTokens: Map<string, string>,
  port: number,
): SyncScheduler | undefined {
  const qdrantUrl = process.env.QDRANT_URL;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!qdrantUrl || !openaiKey) {
    console.log("QDRANT_URL or OPENAI_API_KEY unset — serving the API only, not indexing");
    return undefined;
  }

  // The worker talks to the broker over HTTP even though both live in this
  // process. The indirection is the boundary being enforced (ADR 0038 §3): the
  // worker is a client of the credential, and routing it through the same
  // authorization path as any other caller keeps it that way rather than
  // letting proximity become privilege.
  if (syncTokens.size === 0) {
    console.log("no SYNC_TOKEN_* configured — serving the API only, not indexing");
    return undefined;
  }

  const qdrant = new QdrantHttpClient({ url: qdrantUrl, apiKey: process.env.QDRANT_API_KEY });
  const embedder = new OpenAIEmbedder({ apiKey: openaiKey, model: process.env.EMBEDDING_MODEL });

  // A connection whose SYNC_TOKEN_<name> is missing is reported exactly once,
  // not on every re-read of the targets. It is skipped rather than run with some
  // other connection's token — that token authorizes precisely one connection's
  // source, so borrowing it would either 403 or read the wrong connection.
  const warnedMissingToken = new Set<string>();

  const scheduler = new SyncScheduler({
    // One source per connection, carrying that connection's own sync token. The
    // broker scopes each token to a single connection (auth.ts), so a shared
    // source built with one token would 403 on every other connection's list
    // and fetch — failing their passes and leaving them silently unindexed. The
    // target filter below guarantees a token exists before a connection is ever
    // scheduled, so the lookup here always succeeds.
    sourceFor: (binding) => {
      const token = syncTokens.get(binding.name);
      if (!token) {
        // Unreachable via the scheduler (targets() excludes tokenless
        // connections), but never fall back to another connection's token.
        throw new Error(`no SYNC_TOKEN_* configured for connection ${binding.name}`);
      }
      return new HttpResourceSource({ baseUrl: `http://127.0.0.1:${port}`, token });
    },
    // One writer per connection: every point carries its own connection's
    // allowedRoles, and a shared writer would stamp one client's roles onto
    // another client's chunks.
    writerFor: (binding) =>
      new QdrantCorpusWriter(qdrant, embedder, {
        allowedRoles: binding.allowedRoles,
        vectorSize: EMBEDDING_DIMENSIONS,
      }),
    targets: () =>
      registry
        .listResources()
        .flatMap((cr: ConnectionCustomResource) => {
          const binding = registry.get(cr.metadata.name);
          const collection = collectionOf(cr);
          const intervalMs = reconcileIntervalMs(cr);
          // A connection with no collection has not been reconciled by the
          // controller yet, and one with no interval is not meant to be
          // indexed. Both are ordinary states, not errors.
          if (!binding || !collection || !intervalMs) return [];
          // A connection with no sync token cannot be indexed: its source needs
          // its own token and there is no other to borrow. Reported once so a
          // missing SYNC_TOKEN_<name> is visible, then skipped.
          if (!syncTokens.has(binding.name)) {
            if (!warnedMissingToken.has(binding.name)) {
              console.error(
                `connection ${binding.name} has no SYNC_TOKEN_* configured — not indexing it`,
              );
              warnedMissingToken.add(binding.name);
            }
            return [];
          }
          return [{ binding, collection, intervalMs }];
        }),
    onReport: (report) =>
      console.log(
        `sync ${report.connection}: indexed=${report.indexed} removed=${report.removed} ` +
          `unchanged=${report.unchanged} failed=${report.failed.length} full=${report.full}`,
      ),
    onError: (connection, err) => console.error(`sync ${connection} failed:`, err),
  });
  scheduler.start();
  return scheduler;
}

void main().catch((err: unknown) => {
  console.error("connection-broker failed to start:", err);
  process.exit(1);
});
