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
import { OidcIdentityResolver } from "./rbac/oidc-identity-resolver.js";
import { CompositeIdentityResolver } from "./rbac/composite-identity-resolver.js";
import type { IdentityResolver } from "./rbac/types.js";
import { createRemoteJWKSet } from "jose";
import { CrdSkillRegistry } from "./skills/crd-skill-registry.js";
import { deriveSkillAccess } from "./skills/derive-access.js";
import { QdrantSkillStore } from "./skills/qdrant-skill-store.js";
import { CrdAgentRegistry } from "./agents/crd-agent-registry.js";
import { QdrantAgentStore } from "./agents/qdrant-agent-store.js";
import { NatsAgentChannel } from "./agents/nats-agent-channel.js";
import { AgentRunLauncher } from "./k8s/agentrun-launcher.js";
import { OpenAiEmbedder } from "./vector-store/openai-embedder.js";
import { QdrantToolStore } from "./vector-store/qdrant-store.js";
import { OpenAiActionPlanner } from "./agent/action-planner.js";
import { OpenAiToolFitChecker } from "./agent/tool-fit-checker.js";
import { OpenAiBestEffortResponder } from "./agent/best-effort-responder.js";
import { OpenAiCapabilityNeedChecker } from "./agent/capability-need-checker.js";
import { OpenAiDelegateSelector } from "./agent/delegate-selector.js";
import { OpenAiResponseComposer } from "./agent/response-composer.js";
import { OpenAiSkillFitChecker } from "./agent/skill-fit-checker.js";
import { OpenAiSkillSelector } from "./agent/skill-selector.js";
import { buildAgentGraph } from "./agent/graph.js";
import { OpenAiTaskCompleter } from "./openai/task-completer.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { RedisSessionStore } from "./session/redis-session-store.js";
import type { SessionStore } from "./session/types.js";
import { InvokeServer } from "./server.js";
import { retryWithBackoff } from "./retry.js";
import type { ToolDescriptor } from "./tool-descriptor.js";
import type { SkillDescriptor } from "./skills/types.js";
import type { AgentDescriptor } from "./agents/types.js";
import type { CrdChangeEvent } from "./k8s/crd-watcher.js";

/**
 * Debounce window for re-deriving skill access after a Tool/LocalTool/Skill
 * catalog change (ADR 0020). A burst of watch events (e.g. `kubectl apply`
 * -f` of several CRs at once) should trigger one re-derive + re-upsert, not
 * one per event.
 */
const SKILL_REINDEX_DEBOUNCE_MS = 500;

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

  if (config.identityResolverKind === "oidc" && (!config.oidcIssuer || !config.oidcJwksUri)) {
    console.error(
      "AGENT_OIDC_ISSUER and AGENT_OIDC_JWKS_URI are required when AGENT_IDENTITY_RESOLVER=oidc",
    );
    process.exit(EXIT_STARTUP_FAILURE);
  }

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();

  // Tool catalog discovered from `Tool` custom resources (ADR 0010) --
  // supersedes the static build-time manifest catalog (ADR 0009), which
  // itself superseded annotated-Deployment discovery (ADR 0004). A Tool CR
  // is pure metadata, reconciled/validated by the Go core-controller
  // (controllers/core-controller/), which is also the only thing that ever
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
  // RAG index at startup (ADR 0010). Kept current afterward by a live watch
  // (ADR 0020, wired up below) instead of only refreshing on restart.
  const tools = await registry.listAll();
  const localTools = await localToolRegistry.listAll();
  // One RAG index over both kinds; getByIds/query return whichever descriptor
  // shape (jobTemplate vs localExec) the tool was registered with.
  const allTools = [...tools, ...localTools];
  await vectorStore.upsert(allTools);

  // In-memory mirror of the tool catalog, kept current by the watches below
  // (ADR 0020) so a re-derive of skill access (which needs the FULL current
  // tool list, not just the one that changed) doesn't require re-listing the
  // cluster on every event.
  const toolsById = new Map<string, ToolDescriptor>(allTools.map((tool) => [tool.id, tool]));

  // Agent catalog LIST only (not the full NATS delegation bundle further
  // below) is loaded here, before the Skill section, because a Skill's
  // agentRefs (ADR 0021) needs every agent's allowedRoles for RBAC
  // derivation (derive-access.ts) regardless of whether the full agent-
  // delegation machinery (Qdrant store/AgentRunLauncher/NATS channel) is
  // configured -- same as tools/localTools above. Only meaningful over NATS
  // (agents have no other transport), so this is empty in HTTP-callback-only
  // deployments; a Skill.agentRefs there fails closed the same way a
  // dangling toolRefs entry does (see derive-access.ts).
  const agentRegistry = config.natsUrl
    ? CrdAgentRegistry.fromKubeConfig(config.namespace, config.crdGroup, config.crdVersion, kubeConfig)
    : undefined;
  const agents: AgentDescriptor[] = agentRegistry ? await agentRegistry.listAll() : [];
  const agentsById = new Map<string, AgentDescriptor>(agents.map((agent) => [agent.id, agent]));

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
  // Skills carry no allowedRoles of their own (ADR 0011, extended to agents
  // by ADR 0021) -- derive each skill's retrieval audience from its tools'
  // AND agents' allowedRoles (intersection; unrestricted when a skill
  // declares neither) before indexing.
  await skillStore.upsert(deriveSkillAccess(skills, allTools, [...agentsById.values()]));

  // In-memory mirror of the skill catalog, same purpose as toolsById above.
  const skillsById = new Map<string, SkillDescriptor>(skills.map((skill) => [skill.id, skill]));

  // Re-derives and re-upserts EVERY skill's access from the current
  // toolsById/agentsById/skillsById snapshot (ADR 0020) -- deriveSkillAccess
  // needs the full tool/agent list, not just whichever one changed, so a
  // targeted per-skill upsert isn't possible here the way it is for plain
  // tools/agents. Debounced so a burst of watch events collapses into one
  // re-derive.
  let skillReindexTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSkillReindex = (): void => {
    if (skillReindexTimer) return;
    skillReindexTimer = setTimeout(() => {
      skillReindexTimer = undefined;
      skillStore
        .upsert(deriveSkillAccess([...skillsById.values()], [...toolsById.values()], [...agentsById.values()]))
        .catch((err) => console.error("failed to re-index skills after a catalog change:", err));
    }, SKILL_REINDEX_DEBOUNCE_MS);
  };

  // Live catalog updates (ADR 0020): a Tool/LocalTool/Agent/Skill CR
  // created/edited/deleted after startup now takes effect immediately
  // instead of only on the next orchestrator restart. A Tool/LocalTool/Agent
  // change also affects skill visibility (derive-access.ts, ADR 0021 for
  // agents), so all three schedule a skill re-derive; the Tool/Skill
  // catalogs themselves are kept current directly via targeted vectorStore
  // upserts/deletes.
  const handleToolChange = (event: CrdChangeEvent<ToolDescriptor>): void => {
    if (event.type === "delete") {
      toolsById.delete(event.id);
      void vectorStore.delete([event.id]).catch((err) => console.error(`failed to remove tool "${event.id}":`, err));
    } else {
      toolsById.set(event.descriptor.id, event.descriptor);
      void vectorStore
        .upsert([event.descriptor])
        .catch((err) => console.error(`failed to index tool "${event.descriptor.id}":`, err));
    }
    scheduleSkillReindex();
  };
  const toolWatch = registry.watch(handleToolChange, (err) => console.error("Tool watch error:", err));
  const localToolWatch = localToolRegistry.watch(handleToolChange, (err) =>
    console.error("LocalTool watch error:", err),
  );
  const skillWatch = skillRegistry.watch(
    (event) => {
      if (event.type === "delete") {
        skillsById.delete(event.id);
        void skillStore
          .delete([event.id])
          .catch((err) => console.error(`failed to remove skill "${event.id}":`, err));
      } else {
        skillsById.set(event.descriptor.id, event.descriptor);
      }
      scheduleSkillReindex();
    },
    (err) => console.error("Skill watch error:", err),
  );

  // Agent catalog (Agent CRs, ADR 0010's pattern extended to agent
  // delegation): a full agent loop retrievable via RAG alongside skills, as
  // an equally-weighted top-level delegation target. Only meaningful over
  // NATS -- it needs a live bidirectional channel to a long-running Job --
  // so this whole bundle is skipped in HTTP-callback-only deployments; the
  // graph degrades gracefully to skills-only in that case (see graph.ts).
  // `agentRegistry`/`agents` themselves were already loaded above (before
  // the Skill section) so RBAC derivation has them regardless of NATS;
  // reused here rather than re-listing the cluster.
  let agentDelegation:
    | {
        agentStore: QdrantAgentStore;
        delegateSelector: OpenAiDelegateSelector;
        agentRunLauncher: AgentRunLauncher;
        agentChannel: NatsAgentChannel;
      }
    | undefined;
  let agentWatch: { stop: () => void } | undefined;
  if (config.natsUrl) {
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
    await agentStore.upsert(agents);

    // Live catalog updates (ADR 0020): an Agent descriptor never depends on
    // anything else in the catalog for ITS OWN indexing, so it's still a
    // direct targeted upsert/delete against agentStore here -- but a
    // Skill.agentRefs (ADR 0021) now means an Agent's allowedRoles change
    // CAN change skill visibility, so agentsById is kept current and a skill
    // re-derive is scheduled too, same as a Tool change already triggers.
    agentWatch = agentRegistry!.watch(
      (event) => {
        if (event.type === "delete") {
          agentsById.delete(event.id);
          void agentStore
            .delete([event.id])
            .catch((err) => console.error(`failed to remove agent "${event.id}":`, err));
        } else {
          agentsById.set(event.descriptor.id, event.descriptor);
          void agentStore
            .upsert([event.descriptor])
            .catch((err) => console.error(`failed to index agent "${event.descriptor.id}":`, err));
        }
        scheduleSkillReindex();
      },
      (err) => console.error("Agent watch error:", err),
    );

    agentDelegation = {
      agentStore,
      delegateSelector: new OpenAiDelegateSelector({ model: config.selectionModel }),
      agentRunLauncher: AgentRunLauncher.fromKubeConfig(config.crdGroup, config.crdVersion, kubeConfig),
      agentChannel: await NatsAgentChannel.connect(config.natsUrl),
    };
  }

  let identityResolver: IdentityResolver;
  if (config.identityResolverKind === "oidc") {
    console.error(`Using OIDC identity resolver: issuer=${config.oidcIssuer}`);
    const oidcResolver = new OidcIdentityResolver({
      issuer: config.oidcIssuer!,
      audience: config.oidcAudience,
      rolesClaim: config.oidcRolesClaim,
      jwks: createRemoteJWKSet(new URL(config.oidcJwksUri!)),
    });
    // Callers that structurally cannot present a real, refreshable OIDC
    // token (e.g. Open WebUI: a static configured bearer-token field, no
    // token-refresh mechanism of its own) fall back to a small static map
    // instead of weakening oidc verification for everyone. Only tokens
    // registered in AGENT_STATIC_IDENTITIES get this pass -- callers that
    // can do real OIDC (e.g. integration-gateway) still must.
    identityResolver = config.staticIdentities
      ? new CompositeIdentityResolver(oidcResolver, new StaticIdentityResolver(loadStaticIdentitiesFromEnv(config.staticIdentities)))
      : oidcResolver;
  } else {
    identityResolver = new StaticIdentityResolver(loadStaticIdentitiesFromEnv(config.staticIdentities));
  }

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
  // Fallback cascade for a turn matching no Skill/Agent (graph.ts's
  // noMatchFallback): toolFitChecker gates the full-catalog fallback tool
  // call, bestEffortResponder is the true last resort (a plain LLM answer,
  // never a hardcoded fallback agent).
  const toolFitChecker = new OpenAiToolFitChecker({ model: config.selectionModel });
  const bestEffortResponder = new OpenAiBestEffortResponder({ model: config.selectionModel });
  // Gates catalog retrieval (ADR 0019): skips the RAG search + self-
  // improvement suggestion entirely for requests that never needed a
  // skill/tool/agent in the first place.
  const capabilityNeedChecker = new OpenAiCapabilityNeedChecker({ model: config.selectionModel });
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
    fallbackToolTopK: config.fallbackToolTopK,
    toolFitChecker,
    bestEffortResponder,
    capabilityNeedChecker,
    ...(agentDelegation
      ? {
          agentStore: agentDelegation.agentStore,
          delegateSelector: agentDelegation.delegateSelector,
          agentRunLauncher: agentDelegation.agentRunLauncher,
          agentChannel: agentDelegation.agentChannel,
          agentTopK: config.agentTopK,
          agentRunTimeoutSeconds: config.agentRunTimeoutSeconds,
          callbackSecretRef: { name: config.callbackSecretRefName ?? "", key: config.callbackSecretRefKey },
        }
      : {}),
  });

  // Conversation-session store (docs/adr/0012): remembers each chat's active
  // skill so follow-up turns skip RAG re-selection when the fit-check
  // passes. Redis-backed (docs/adr/0016) when AGENT_REDIS_URL is set, so
  // sessions survive restarts and are shared across replicas; otherwise
  // falls back to the single-replica in-memory adapter.
  let redisSessionStore: RedisSessionStore | undefined;
  let sessionStore: SessionStore;
  if (config.redisUrl) {
    redisSessionStore = new RedisSessionStore(config.redisUrl, {
      ttlSeconds: config.sessionTtlSeconds,
    });
    await retryWithBackoff("redis startup check", () => redisSessionStore!.connect(), {
      attempts: 12,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
    });
    console.error(`Using Redis session store: ${config.redisUrl}`);
    sessionStore = redisSessionStore;
  } else {
    sessionStore = new InMemorySessionStore({
      ttlMs: config.sessionTtlSeconds * 1000,
      maxEntries: config.sessionMaxEntries,
    });
  }
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
    // Stop the CRD watches (ADR 0020) before closing everything else --
    // otherwise a reconnect racing the process exit would log a spurious
    // watch error.
    toolWatch.stop();
    localToolWatch.stop();
    skillWatch.stop();
    agentWatch?.stop();
    if (skillReindexTimer) clearTimeout(skillReindexTimer);
    const closers: Promise<void>[] = [invokeServer.close()];
    if (callbackReceiver) closers.push(callbackReceiver.close());
    if (config.natsUrl) {
      // NatsJobReceiver.close() drains the connection.
      closers.push((jobResultReceiver as NatsJobReceiver).close());
    }
    if (agentDelegation) closers.push(agentDelegation.agentChannel.close());
    if (redisSessionStore) closers.push(redisSessionStore.close());
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

