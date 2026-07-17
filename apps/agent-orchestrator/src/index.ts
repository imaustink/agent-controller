import * as k8s from "@kubernetes/client-node";
import { config } from "./config.js";
import { CallbackReceiver } from "./callback/receiver.js";
import { NatsJobReceiver } from "./callback/nats-job-receiver.js";
import type { JobResultReceiver } from "./callback/receiver.js";
import { ToolRunLauncher } from "./k8s/toolrun-launcher.js";
import { LocalToolExecutor, K8sSecretReader } from "./local/local-tool-executor.js";
import { CrdToolRegistry } from "./registry/crd-tool-registry.js";
import { CrdLocalToolRegistry } from "./registry/crd-local-tool-registry.js";
import { loadStaticIdentitiesFromEnv, StaticIdentityResolver } from "./rbac/static-identity-resolver.js";
import { CrdSkillRegistry } from "./skills/crd-skill-registry.js";
import { deriveSkillAccess } from "./skills/derive-access.js";
import { QdrantSkillStore } from "./skills/qdrant-skill-store.js";
import type { AgentDescriptor } from "./agents/types.js";
import { CrdAgentRegistry } from "./agents/crd-agent-registry.js";
import { QdrantAgentStore } from "./agents/qdrant-agent-store.js";
import { NatsAgentChannel } from "./agents/nats-agent-channel.js";
import { AgentRunLauncher } from "./k8s/agentrun-launcher.js";
import { OpenAiEmbedder } from "./vector-store/openai-embedder.js";
import { QdrantToolStore } from "./vector-store/qdrant-store.js";
import { OpenAiActionPlanner } from "./agent/action-planner.js";
import { OpenAiDelegateSelector } from "./agent/delegate-selector.js";
import { OpenAiResponseComposer } from "./agent/response-composer.js";
import { OpenAiSkillFitChecker } from "./agent/skill-fit-checker.js";
import { OpenAiSkillSelector } from "./agent/skill-selector.js";
import { buildAgentGraph } from "./agent/graph.js";
import { OpenAiTaskCompleter } from "./openai/task-completer.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { InvokeServer } from "./server.js";
import { retryWithBackoff } from "./retry.js";

/** Process exit code for startup failures — this is a long-lived service, not a one-shot CLI (ADR 0006). */
const EXIT_STARTUP_FAILURE = 1;

/**
 * Long-lived service entry point (ADR 0006). Starts two HTTP listeners and
 * keeps running until terminated:
 *
 * - `InvokeServer` (`AGENT_HTTP_PORT`) — consumer-facing: `POST /invoke`
 *   accepts a request + `Authorization: Bearer <token>`, returns
 *   `202 { id }` immediately; `GET /invoke/:id` polls for the result. See
 *   src/server.ts and ADR 0006 for why this is async rather than blocking.
 * - `CallbackReceiver` (`AGENT_CALLBACK_PORT`) — the existing Job ->
 *   orchestrator result channel (docs/messaging.md), unchanged.
 */
async function main(): Promise<void> {
  // Validate startup requirements based on the result-channel mode.
  if (!config.natsUrl) {
    // HTTP callback mode: both the secret value (for HMAC verification) and
    // the secret ref (for ToolRunLauncher to embed in the ToolRun CR) are
    // required.
    if (!config.callbackSecret) {
      console.error("AGENT_CALLBACK_SECRET is required when AGENT_NATS_URL is not set");
      process.exit(EXIT_STARTUP_FAILURE);
    }
    if (!config.callbackSecretRefName) {
      console.error(
        "AGENT_CALLBACK_SECRET_REF_NAME is required when AGENT_NATS_URL is not set -- " +
          "ToolRunLauncher references the callback HMAC secret by k8s Secret name/key " +
          "(never plaintext in the ToolRun CR), so the controller can wire it into " +
          "the launched Job via secretKeyRef (ADR 0010)",
      );
      process.exit(EXIT_STARTUP_FAILURE);
    }
  }

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();

  // Tool catalog discovered from `Tool` custom resources (ADR 0010) --
  // supersedes the static build-time manifest catalog (ADR 0009), which
  // itself superseded annotated-Deployment discovery (ADR 0004). A Tool CR
  // is pure metadata, reconciled/validated by the Go tool-controller
  // (controllers/tool-controller/), which is also the only thing that ever
  // creates a k8s Job now.
  const registry = CrdToolRegistry.fromKubeConfig(config.namespace, config.crdGroup, config.crdVersion, kubeConfig);
  // LocalTools (ADR 0014): tools executed in-pod by a per-language executor
  // sidecar instead of as a k8s Job. Discovered from LocalTool CRs and unioned
  // with the container-tool catalog below, so skills reference either kind
  // transparently by CR name.
  const localToolRegistry = CrdLocalToolRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  // callbackSecretRefName is only used by ToolRunLauncher's HTTP callback
  // path -- when NATS is configured it's never embedded into ToolRun CRs.
  // Passing an empty string as a safe sentinel is fine: if a NATS ToolRun
  // were accidentally created with the HTTP path the Go controller's own
  // validation would catch the empty secretRef.name.
  const containerToolLauncher = ToolRunLauncher.fromKubeConfig(
    config.crdGroup,
    config.crdVersion,
    { name: config.callbackSecretRefName ?? "", key: config.callbackSecretRefKey },
    kubeConfig,
  );
  const embedder = new OpenAiEmbedder({ model: config.embeddingModel });
  const vectorStore = new QdrantToolStore(
    {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      collection: config.qdrantCollection,
      vectorSize: config.qdrantVectorSize,
    },
    embedder,
  );
  // First Qdrant call of the process. After a full-cluster restart this pod
  // routinely comes up before Qdrant does, so wait for it to become
  // reachable instead of crashing (~2 min worst case: 1s doubling to a 15s
  // cap). Once this succeeds Qdrant is up, so later calls aren't retried.
  await retryWithBackoff("qdrant startup check", () => vectorStore.ensureCollection(), {
    attempts: 12,
    initialDelayMs: 1_000,
    maxDelayMs: 15_000,
  });

  // Load the current Tool catalog from the cluster and upsert it into the
  // RAG index at startup (ADR 0010 -- still a one-shot read, not a live
  // watch loop; same documented limitation as the superseded ADR 0009
  // manifest approach, just against CRDs instead of files).
  const tools = await registry.listAll();
  const localTools = await localToolRegistry.listAll();
  // One RAG index over both kinds; getByIds/query return whichever descriptor
  // shape (jobTemplate vs localExec) the tool was registered with.
  const allTools = [...tools, ...localTools];
  await vectorStore.upsert(allTools);

  // Skill catalog (ADR 0010, supersedes the static src/skills/catalog.ts
  // array from ADR 0008): Skill custom resources, upserted into their own
  // Qdrant collection at startup, same reconcile shape as tools.
  const skillRegistry = CrdSkillRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  const skillStore = new QdrantSkillStore(
    {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      collection: config.skillsQdrantCollection,
      vectorSize: config.qdrantVectorSize,
    },
    embedder,
  );
  await skillStore.ensureCollection();
  const skills = await skillRegistry.listAll();
  // Skills carry no allowedRoles of their own (ADR 0011) -- derive each
  // skill's retrieval audience from its tools' allowedRoles (intersection;
  // unrestricted when a skill declares no tools) before indexing. Note this
  // happens at startup only: a Tool CR role change affects skill visibility
  // after the next restart, same staleness as the rest of the catalog.
  await skillStore.upsert(deriveSkillAccess(skills, allTools));

  // Agent catalog (Agent CRs, ADR 0010's pattern extended to agent
  // delegation): a full agent loop retrievable via RAG alongside skills, as
  // an equally-weighted top-level delegation target. Only meaningful over
  // NATS -- it needs a live bidirectional channel to a long-running Job --
  // so this whole bundle is skipped in HTTP-callback-only deployments; the
  // graph degrades gracefully to skills-only in that case (see graph.ts).
  let agentDelegation:
    | {
        agentStore: QdrantAgentStore;
        delegateSelector: OpenAiDelegateSelector;
        agentRunLauncher: AgentRunLauncher;
        agentChannel: NatsAgentChannel;
        fallbackAgent: AgentDescriptor | undefined;
      }
    | undefined;
  if (config.natsUrl) {
    const agentRegistry = CrdAgentRegistry.fromKubeConfig(
      config.namespace,
      config.crdGroup,
      config.crdVersion,
      kubeConfig,
    );
    const agentStore = new QdrantAgentStore(
      {
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        collection: config.agentsQdrantCollection,
        vectorSize: config.qdrantVectorSize,
      },
      embedder,
    );
    await agentStore.ensureCollection();
    const agents = await agentRegistry.listAll();
    await agentStore.upsert(agents);

    agentDelegation = {
      agentStore,
      delegateSelector: new OpenAiDelegateSelector({ model: config.selectionModel }),
      agentRunLauncher: AgentRunLauncher.fromKubeConfig(config.crdGroup, config.crdVersion, kubeConfig),
      agentChannel: await NatsAgentChannel.connect(config.natsUrl),
      // Best-effort delegation target for a turn matching no Skill/Agent at
      // all (graph.ts's selectDelegate). Empty AGENT_FALLBACK_AGENT_NAME
      // disables the fallback and keeps today's fail-closed behavior.
      fallbackAgent: config.fallbackAgentName ? agents.find((a) => a.name === config.fallbackAgentName) : undefined,
    };
  }

  const identities = loadStaticIdentitiesFromEnv(config.staticIdentities);
  const identityResolver = new StaticIdentityResolver(identities);

  // Result channel: NATS when AGENT_NATS_URL is set, HTTP callback otherwise.
  let jobResultReceiver: JobResultReceiver;
  let callbackReceiver: CallbackReceiver | undefined;
  if (config.natsUrl) {
    console.error(`Using NATS result channel: ${config.natsUrl}`);
    jobResultReceiver = await NatsJobReceiver.connect(config.natsUrl);
  } else {
    callbackReceiver = new CallbackReceiver(config.callbackSecret!);
    jobResultReceiver = callbackReceiver;
  }

  const skillSelector = new OpenAiSkillSelector({ model: config.selectionModel });
  const skillFitChecker = new OpenAiSkillFitChecker({ model: config.selectionModel });
  const actionPlanner = new OpenAiActionPlanner({ model: config.selectionModel });
  // Post-tool response composition (ADR 0015): lets the active skill's own
  // instructions add any follow-up around a tool's verbatim output, so no
  // per-tool prompt lives in the agent graph.
  const responseComposer = new OpenAiResponseComposer({ model: config.selectionModel });

  // Executes LocalTools by RPC to the per-language sidecars over the shared
  // unix-socket dir (ADR 0014). Secret-backed env is resolved here (the
  // orchestrator holds the k8s identity; the sidecars deliberately do not).
  const localToolExecutor = new LocalToolExecutor({
    socketDir: config.localToolSocketDir,
    defaultTimeoutSeconds: config.localToolTimeoutSeconds,
    secretReader: K8sSecretReader.fromKubeConfig(config.namespace, kubeConfig),
  });

  const graph = buildAgentGraph({
    identityResolver,
    skillStore,
    skillSelector,
    skillFitChecker,
    vectorStore,
    actionPlanner,
    responseComposer,
    containerToolLauncher,
    jobResultReceiver,
    localToolExecutor,
    callbackBaseUrl: config.callbackBaseUrl,
    callbackSecret: config.callbackSecret,
    natsUrl: config.natsUrl,
    skillTopK: config.skillTopK,
    ...(agentDelegation
      ? {
          agentStore: agentDelegation.agentStore,
          delegateSelector: agentDelegation.delegateSelector,
          agentRunLauncher: agentDelegation.agentRunLauncher,
          agentChannel: agentDelegation.agentChannel,
          agentTopK: config.agentTopK,
          agentRunTimeoutSeconds: config.agentRunTimeoutSeconds,
          callbackSecretRef: { name: config.callbackSecretRefName ?? "", key: config.callbackSecretRefKey },
          fallbackAgent: agentDelegation.fallbackAgent,
        }
      : {}),
  });

  // Conversation-session store (docs/adr/0012): remembers each chat's active
  // skill so follow-up turns skip RAG re-selection when the fit-check
  // passes. In-memory -- assumes the chart's default single replica.
  const sessionStore = new InMemorySessionStore({
    ttlMs: config.sessionTtlSeconds * 1000,
    maxEntries: config.sessionMaxEntries,
  });
  // Answers Open WebUI's internal housekeeping completions (title/tags/query
  // generation) directly, bypassing the agent graph -- see server.ts's
  // handleInternalUiTask and isInternalUiTaskRequest.
  const taskCompleter = new OpenAiTaskCompleter();
  const invokeServer = new InvokeServer(graph, sessionStore, taskCompleter);

  if (callbackReceiver) {
    await callbackReceiver.listen(config.callbackPort);
    await invokeServer.listen(config.httpPort);
    console.error(
      `agent-orchestrator listening: invoke API on :${config.httpPort}, Job callbacks on :${config.callbackPort}`,
    );
  } else {
    await invokeServer.listen(config.httpPort);
    console.error(`agent-orchestrator listening: invoke API on :${config.httpPort} (NATS result channel)`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`${signal} received, shutting down`);
    const closers: Promise<void>[] = [invokeServer.close()];
    if (callbackReceiver) closers.push(callbackReceiver.close());
    if (config.natsUrl) {
      // NatsJobReceiver.close() drains the connection.
      closers.push((jobResultReceiver as NatsJobReceiver).close());
    }
    if (agentDelegation) closers.push(agentDelegation.agentChannel.close());
    await Promise.all(closers);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // Log the full error (stack + any extra fields the underlying client
  // attached, e.g. Qdrant/OpenAI clients often put the response body on a
  // non-standard property) -- a bare `.message` here was hiding the actual
  // cause of startup failures (just "Bad Request" with nothing else).
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (err && typeof err === "object") {
    const { message: _m, stack: _s, ...rest } = err as Record<string, unknown>;
    if (Object.keys(rest).length > 0) console.error("additional error fields:", rest);
  }
  process.exit(EXIT_STARTUP_FAILURE);
});

