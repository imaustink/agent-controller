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
import { OpenWebUiForwardedUserResolver } from "./rbac/openwebui-forwarded-user-resolver.js";
import type { IdentityResolver } from "./rbac/types.js";
import { createRemoteJWKSet } from "jose";
import { CrdSkillRegistry } from "./skills/crd-skill-registry.js";
import { deriveSkillAccess } from "./skills/derive-access.js";
import {
  CrdConnectionRegistry,
  CrdKnowledgeBaseRegistry,
} from "./knowledge-base/crd-registry.js";
import { deriveKnowledgeBaseIndex } from "./knowledge-base/index-derivation.js";
import {
  knowledgeBaseToolIds,
  knowledgeBaseSearchToolId,
  knowledgeBaseSkillId,
  corpusGetToolId,
  type CorpusDescriptor,
  type KnowledgeBaseDescriptor,
} from "./knowledge-base/types.js";
import { QdrantSkillStore } from "./skills/qdrant-skill-store.js";
import { CrdAgentRegistry } from "./agents/crd-agent-registry.js";
import { CrdIdentityProviderRegistry, InMemoryIdentityProviderCatalog } from "./identity-link/identity-provider-catalog.js";
import { CrdIntegrationRouteRegistry } from "./routing/crd-integration-route-registry.js";
import { QdrantAgentStore } from "./agents/qdrant-agent-store.js";
import { NatsAgentChannel } from "./agents/nats-agent-channel.js";
import { AgentRunLauncher } from "./k8s/agentrun-launcher.js";
import { IdentityLinkGatewayClient } from "./identity-link/gateway-client.js";
import { ClaudeAuthGatewayClient } from "./identity-link/claude-auth-gateway-client.js";
import { ClaudeRemoteGatewayClient } from "./identity-link/claude-remote-gateway-client.js";
import { OpenAiEmbedder } from "./vector-store/openai-embedder.js";
import { CorpusLookup } from "./knowledge-base/lookup.js";
import { CorpusReader } from "./knowledge-base/reader.js";
import { KnowledgeBaseSearcher } from "./knowledge-base/searcher.js";
import { LinkedCredentials } from "./knowledge-base/linked-credentials.js";
import { QdrantCorpusStore } from "./knowledge-base/qdrant-corpus-store.js";
import { QdrantToolStore } from "./vector-store/qdrant-store.js";
import { QdrantCallerToolStore } from "./caller-tools/qdrant-caller-tool-store.js";
import { OpenAiActionPlanner } from "./agent/action-planner.js";
import { OpenAiToolFitChecker } from "./agent/tool-fit-checker.js";
import { OpenAiBestEffortResponder } from "./agent/best-effort-responder.js";
import { OpenAiCapabilityNeedChecker } from "./agent/capability-need-checker.js";
import { OpenAiDelegateSelector } from "./agent/delegate-selector.js";
import { OpenAiResponseComposer } from "./agent/response-composer.js";
import { OpenAiSkillFitChecker } from "./agent/skill-fit-checker.js";
import { OpenAiSkillSelector } from "./agent/skill-selector.js";
import { buildAgentGraph } from "./agent/graph.js";
import { TemporalEngine } from "./engine/temporal-engine.js";
import { OpenAiTaskCompleter } from "./openai/task-completer.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { RedisSessionStore } from "./session/redis-session-store.js";
import { RedisInvocationStore } from "./invocation/redis-invocation-store.js";
import { InMemoryAgentReplyStore, RedisAgentReplyStore, type AgentReplyStore } from "./agents/reply-store.js";
import { InMemoryInvocationStore, type InvocationStore } from "./invocation/types.js";
import type { SessionStore } from "./session/types.js";
import { clearAgentRunAwaitingReply, markAgentRunAwaitingReply } from "./session/inflight-agent-run.js";
import { InvokeServer, type AgentGraphLike } from "./server.js";
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

  if (config.staticIdentities && !config.openWebUiUserJwtSecret) {
    // Not a startup failure -- some deployments legitimately use
    // AGENT_STATIC_IDENTITIES for non-Open-WebUI test/dev callers that don't
    // send a per-user JWT at all. But when the static fallback IS serving
    // Open WebUI, every one of its users resolves to the same shared
    // subject, so any credential linked by one is usable by all of them with
    // no auth check (see OpenWebUiForwardedUserResolver). Loud warning
    // rather than silent, since this is easy to leave misconfigured.
    console.error(
      "WARNING: AGENT_STATIC_IDENTITIES is set but AGENT_OPENWEBUI_USER_JWT_SECRET is not -- " +
        "if the static identity map is serving Open WebUI, every Open WebUI user resolves to " +
        "the same shared subject and can use each other's linked credentials (e.g. GitHub " +
        "identity-link, ADR 0022) with no authentication. Set AGENT_OPENWEBUI_USER_JWT_SECRET " +
        "to Open WebUI's FORWARD_USER_INFO_HEADER_JWT_SECRET to resolve per-user identity instead.",
    );
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
  // Identity-provider catalog (envVar/label/flow/crossEntryPoint per
  // provider, docs/adr/0027 and the CRD's own doc comment): discovered from
  // `IdentityProvider` CRs, the same ADR 0020 listAll()-then-watch() pattern
  // as every other catalog here -- what used to be a hardcoded TypeScript map
  // in authorization-service.ts is now cluster config AuthorizationService
  // and graph.ts's identity-gate helpers both read through this live view.
  const identityProviderRegistry = CrdIdentityProviderRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  const identityProviderCatalog = new InMemoryIdentityProviderCatalog(await identityProviderRegistry.listAll());
  const identityProviderWatch = identityProviderRegistry.watch(
    (event) => {
      if (event.type === "delete") identityProviderCatalog.delete(event.id);
      else identityProviderCatalog.upsert(event.descriptor.id, event.descriptor.config);
    },
    (err) => console.error("IdentityProvider watch error:", err),
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

  // Knowledge bases (ADR 0039) and the scoped Corpora they compose
  // (ADR 0038). Neither is retrievable in its own right: a KnowledgeBase
  // DERIVES a Skill -- which is what makes its search/fetch and its members'
  // GET tools reachable only once that knowledge base has been selected -- and
  // those generated tools are indexed HIDDEN so they never compete in open
  // retrieval.
  // Gated (config.knowledgeBasesEnabled): a derived kb:<name>/search descriptor
  // has no executor yet, so indexing one before the broker exists lets the
  // planner select a knowledge base and then fail at dispatch.
  const connectionRegistry = CrdConnectionRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  const knowledgeBaseRegistry = CrdKnowledgeBaseRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  const corporaById = new Map<string, CorpusDescriptor>(
    config.knowledgeBasesEnabled
      ? (await connectionRegistry.listAll()).map((connection) => [connection.id, connection])
      : [],
  );
  const knowledgeBasesById = new Map<string, KnowledgeBaseDescriptor>(
    config.knowledgeBasesEnabled
      ? (await knowledgeBaseRegistry.listAll()).map((kb) => [kb.id, kb])
      : [],
  );

  const indexKnowledgeBases = async (): Promise<void> => {
    if (!config.knowledgeBasesEnabled) return;
    const derived = deriveKnowledgeBaseIndex([...knowledgeBasesById.values()], corporaById);
    await vectorStore.upsert(derived.tools);
    await skillStore.upsert(derived.skills);
  };
  await indexKnowledgeBases();

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
      // Knowledge bases derive skills too, off the same trigger and the same
      // debounce: a Corpus change can alter a knowledge base's audience,
      // its tool list and its generated markdown at once.
      void indexKnowledgeBases().catch((err) =>
        console.error("failed to re-index knowledge bases after a catalog change:", err),
      );
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

  const connectionWatch = !config.knowledgeBasesEnabled ? undefined : connectionRegistry.watch(
    (event) => {
      if (event.type === "delete") {
        corporaById.delete(event.id);
        // A withdrawn source must not linger as a callable tool. The knowledge
        // bases that referenced it keep working over their remaining members --
        // a vanished connection is a dangling ref, which contributes nothing
        // rather than failing the whole skill closed.
        void vectorStore
          .delete([corpusGetToolId(event.id)])
          .catch((err) => console.error(`failed to remove connection tool "${event.id}":`, err));
      } else {
        corporaById.set(event.descriptor.id, event.descriptor);
      }
      scheduleSkillReindex();
    },
    (err) => console.error("Connection watch error:", err),
  );

  const knowledgeBaseWatch = !config.knowledgeBasesEnabled ? undefined : knowledgeBaseRegistry.watch(
    (event) => {
      if (event.type === "delete") {
        knowledgeBasesById.delete(event.id);
        // Delete the DERIVED ids, not the CR name: deleting by CR name would
        // leave the skill selectable, pointing at tools that no longer exist.
        void skillStore
          .delete([knowledgeBaseSkillId(event.id)])
          .catch((err) => console.error(`failed to remove knowledge base "${event.id}":`, err));
        void vectorStore
          .delete(knowledgeBaseToolIds(event.id))
          .catch((err) => console.error(`failed to remove knowledge base tools "${event.id}":`, err));
      } else {
        knowledgeBasesById.set(event.descriptor.id, event.descriptor);
      }
      scheduleSkillReindex();
    },
    (err) => console.error("KnowledgeBase watch error:", err),
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
  let redisAgentReplyStore: RedisAgentReplyStore | undefined;
  let agentReplyStore: AgentReplyStore = new InMemoryAgentReplyStore();
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

    // Durable home for an agent's concluding reply, written before its ack --
    // what makes releasing the agent's hold safe across a rollout.
    if (config.redisUrl) {
      redisAgentReplyStore = new RedisAgentReplyStore(config.redisUrl, { ttlSeconds: config.invocationTtlSeconds });
      await retryWithBackoff("redis agent reply store startup check", () => redisAgentReplyStore!.connect(), {
        attempts: 12,
        initialDelayMs: 1_000,
        maxDelayMs: 15_000,
      });
      agentReplyStore = redisAgentReplyStore;
    }

    agentDelegation = {
      agentStore,
      delegateSelector: new OpenAiDelegateSelector({ model: config.selectionModel }),
      agentRunLauncher: AgentRunLauncher.fromKubeConfig(config.crdGroup, config.crdVersion, kubeConfig),
      // The reply store is what makes the protocol's `reply_ack` safe: the
      // concluding reply is persisted before the ack releases the agent's
      // hold, so a rollout between the two can no longer destroy the only copy
      // of the answer. Without Redis it is in-process, and that guarantee is
      // limited to this pod -- the same caveat as the invocation store.
      agentChannel: await NatsAgentChannel.connect(config.natsUrl, "agent", agentReplyStore),
    };
  }

  // Declarative event->Skill/Agent/Tool routing table (IntegrationRoute CRs):
  // lets a caller (integration-gateway) send an `event` descriptor alongside
  // `request` on /invoke and have this bypass RAG retrieval when it matches
  // an installed route -- deterministic dispatch for triggers whose intent
  // is already unambiguous (e.g. a GitHub issue assigned to the bot), see
  // docs/integrations-gateway.md. No routes installed -> every request goes
  // through RAG retrieval exactly as before this feature existed.
  const integrationRouteRegistry = CrdIntegrationRouteRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  await integrationRouteRegistry.listAll();
  const integrationRouteWatch = integrationRouteRegistry.watch((err) =>
    console.error("IntegrationRoute watch error:", err),
  );

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

  // Resolves identity from Open WebUI's per-request signed user JWT rather
  // than its shared static bearer token (see graph.ts's resolveIdentity and
  // OpenWebUiForwardedUserResolver) -- without this, every Open WebUI user
  // resolves to the same shared subject via the static-identities fallback
  // above, so linking an OAuth identity (e.g. GitHub, ADR 0022) as one user
  // makes it usable by every other Open WebUI user with no auth check.
  // Absent config -> resolveIdentity falls back to the shared-subject path,
  // same as before this resolver existed.
  const forwardedUserIdentityResolver = config.openWebUiUserJwtSecret
    ? new OpenWebUiForwardedUserResolver({ secret: config.openWebUiUserJwtSecret, roles: config.openWebUiUserRoles })
    : undefined;

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

  // Per-caller GitHub identity (replaces the old shared static credential for
  // any Agent that declares `identityProviders`, e.g. opencode-swe-agent):
  // absent config -> stays unconfigured, so delegateToAgent fails closed with
  // a clear per-turn error for such an Agent rather than crashing startup.
  const identityLinkGateway =
    config.identityLinkGatewayUrl && config.identityLinkGatewayToken
      ? new IdentityLinkGatewayClient({
          baseUrl: config.identityLinkGatewayUrl,
          token: config.identityLinkGatewayToken,
        })
      : undefined;

  // Said out loud at startup because the failure it guards against is
  // otherwise SILENT: an authcode link dies at GitHub's own consent screen
  // ("The redirect_uri is not associated with this application") before any
  // request reaches this process, so nothing here ever logs it. Worse, every
  // already-linked caller keeps working off a refreshed token and never
  // re-enters the flow, so a mismatched Callback URL only surfaces for
  // first-time linkers and can sit unnoticed indefinitely.
  if (identityLinkGateway) {
    console.log(
      `identity-link default flow: ${config.defaultIdentityLinkFlow}` +
        (config.defaultIdentityLinkFlow === "authcode"
          ? " -- requires the GitHub App's registered Callback URL to exactly match integration-gateway's " +
            "GITHUB_OAUTH_REDIRECT_URI; set AGENT_DEFAULT_IDENTITY_LINK_FLOW=device to use the redirect-free device flow instead"
          : " -- user-code flow, no redirect URI involved"),
    );
  }

  // Per-caller Claude Code OAuth credential (docs/adr/0027) -- the `claude`
  // provider's counterpart to `identityLinkGateway` above, reusing the SAME
  // gateway host/bearer token (no separate config): whether integration-
  // gateway's own `/claude-auth/*` routes are actually reachable there is
  // gated by ITS OWN `claudeAuth.enabled`/`GATEWAY_CLAUDE_AUTH_ENABLED`
  // config, not this one -- an Agent that never declares
  // `identityProviders: ["claude"]` never calls this client regardless.
  const claudeAuthGateway =
    config.identityLinkGatewayUrl && config.identityLinkGatewayToken
      ? new ClaudeAuthGatewayClient({
          baseUrl: config.identityLinkGatewayUrl,
          token: config.identityLinkGatewayToken,
        })
      : undefined;

  // Per-caller Claude Code `login` credential (the remote-control invocation
  // counterpart to `claudeAuthGateway` above) -- same gateway host/bearer
  // token, same `GATEWAY_CLAUDE_AUTH_ENABLED` posture (it's the same
  // integration-gateway feature, just a different `mode`), gated by whether
  // an Agent declares `identityProviders: ["claude-remote"]`.
  const claudeRemoteGateway =
    config.identityLinkGatewayUrl && config.identityLinkGatewayToken
      ? new ClaudeRemoteGatewayClient({
          baseUrl: config.identityLinkGatewayUrl,
          token: config.identityLinkGatewayToken,
        })
      : undefined;

  // Executes LocalTools by RPC to the per-language sidecars over the shared
  // unix-socket dir (ADR 0014). Secret-backed env is resolved here (the
  // orchestrator holds the k8s identity; the sidecars deliberately do not).
  const localToolExecutor = new LocalToolExecutor({
    socketDir: config.localToolSocketDir,
    defaultTimeoutSeconds: config.localToolTimeoutSeconds,
    secretReader: K8sSecretReader.fromKubeConfig(config.namespace, kubeConfig),
  });

  // Conversation-session store (docs/adr/0012): remembers each chat's active
  // skill so follow-up turns skip RAG re-selection when the fit-check
  // passes. Redis-backed (docs/adr/0016) when AGENT_REDIS_URL is set, so
  // sessions survive restarts and are shared across replicas; otherwise
  // falls back to the single-replica in-memory adapter.
  //
  // Built before the graph because the graph writes to it mid-turn now: the
  // agent-run resume anchor (`session/inflight-agent-run.ts`) has to be
  // persisted before a wait begins, not with the turn's outcome.
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

  // Where `/invoke`'s accept-then-poll records live. On Redis, ANY replica can
  // answer a poll -- which is what stops a rollout losing every turn accepted
  // in the seconds around it, and is the precondition for running more than one
  // replica at all. Without Redis this is the in-process Map it has always
  // been, and the same single-replica caveat applies.
  //
  // TTL has to outlast the longest poll budget a caller uses, not the session
  // TTL: integration-gateway polls for up to `pollTimeoutMs` (15 minutes by
  // default) on one record.
  let redisInvocationStore: RedisInvocationStore | undefined;
  let invocationStore: InvocationStore;
  if (config.redisUrl) {
    redisInvocationStore = new RedisInvocationStore(config.redisUrl, {
      ttlSeconds: config.invocationTtlSeconds,
    });
    await retryWithBackoff("redis invocation store startup check", () => redisInvocationStore!.connect(), {
      attempts: 12,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
    });
    console.error(`Using Redis invocation store: ${config.redisUrl} (ttl ${config.invocationTtlSeconds}s)`);
    invocationStore = redisInvocationStore;
  } else {
    console.error(
      "No REDIS_URL: /invoke records are in-process, so a poll must reach the SAME pod that accepted it. " +
        "A rollout loses turns accepted around it, and more than one replica will 404 polls.",
    );
    invocationStore = new InMemoryInvocationStore();
  }

  // Knowledge bases (docs/adr/0039, 0040, 0043). Both of these were previously
  // accepted as graph dependencies and supplied by NOBODY, so a derived
  // kb:<name>/search or corpus:<name>/get could be indexed, retrieved and
  // picked by the planner — and then failed the turn with "knowledge bases are
  // not configured", after the model had already committed to an approach.
  //
  // Built only when there is a broker to talk to. Retrieval probes every
  // candidate against the source with the caller's own token (ADR 0040), and
  // the broker is what holds those credentials; without it there is nothing to
  // probe through, and the tools are not generated either.
  const knowledgeBaseSearcher =
    config.knowledgeBasesEnabled && config.connectionBrokerUrl && identityLinkGateway
      ? new KnowledgeBaseSearcher({
          openCorpus: async (collection?: string) =>
            collection
              ? new QdrantCorpusStore(
                  { url: config.qdrantUrl, collection, ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}) },
                  embedder,
                )
              : undefined,
          brokerUrl: config.connectionBrokerUrl,
          brokerToken: config.connectionBrokerToken ?? "",
          credentials: new LinkedCredentials(identityLinkGateway),
        })
      : undefined;

  const corpusReader =
    config.knowledgeBasesEnabled && config.connectionBrokerUrl && identityLinkGateway
      ? new CorpusReader({
          brokerUrl: config.connectionBrokerUrl,
          brokerToken: config.connectionBrokerToken ?? "",
          credentials: new LinkedCredentials(identityLinkGateway),
        })
      : undefined;

  const corpusLookup =
    config.knowledgeBasesEnabled && config.connectionBrokerUrl && identityLinkGateway
      ? new CorpusLookup({
          brokerUrl: config.connectionBrokerUrl,
          brokerToken: config.connectionBrokerToken ?? "",
          credentials: new LinkedCredentials(identityLinkGateway),
        })
      : undefined;

  if (config.knowledgeBasesEnabled && !knowledgeBaseSearcher) {
    // Not fatal — a deployment may index without serving — but worth saying,
    // because the symptom is otherwise a knowledge base that fills up fine and
    // cannot be asked anything.
    console.error(
      "WARNING: knowledge bases are enabled but AGENT_CONNECTION_BROKER_URL or the identity-link " +
        "gateway is unset, so no knowledge base can be searched or read.",
    );
  }

  const graph = buildAgentGraph({
    identityResolver,
    forwardedUserIdentityResolver,
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
    // Direct (non-RAG) tool lookup for a running sub-agent's own tool_call
    // requests (docs/adr/0028) -- reuses the same live-updated toolsById map
    // built above for skill re-derivation, rather than a second catalog.
    toolCatalog: { getById: (id: string) => toolsById.get(id) },
    skillTopK: config.skillTopK,
    fallbackToolTopK: config.fallbackToolTopK,
    toolFitChecker,
    bestEffortResponder,
    capabilityNeedChecker,
    identityProviderCatalog,
    ...(identityLinkGateway ? { identityLinkGateway } : {}),
    ...(knowledgeBaseSearcher ? { knowledgeBaseSearcher } : {}),
    ...(corpusReader ? { corpusReader } : {}),
    ...(corpusLookup ? { corpusLookup } : {}),
    ...(claudeAuthGateway ? { claudeAuthGateway } : {}),
    ...(claudeRemoteGateway ? { claudeRemoteGateway } : {}),
    // Same client, passed a second time under its non-IdentityLinkPort
    // capability: minting the per-run grant that lets a launched run persist
    // the credentials its Claude Code CLI refreshed in-pod (graph.ts's
    // `CREDENTIALS_WRITEBACK_ENV`). Nothing new to configure -- if the
    // gateway/bearer above is set, so is this.
    ...(claudeRemoteGateway ? { claudeRemoteWriteback: claudeRemoteGateway } : {}),
    ...(agentDelegation
      ? {
          agentStore: agentDelegation.agentStore,
          delegateSelector: agentDelegation.delegateSelector,
          agentRunLauncher: agentDelegation.agentRunLauncher,
          agentChannel: agentDelegation.agentChannel,
          agentTopK: config.agentTopK,
          agentRunTimeoutSeconds: config.agentRunTimeoutSeconds,
          agentIdleTimeoutSeconds: config.agentIdleTimeoutSeconds,
          // Resume anchor for an agent turn whose wait is interrupted (a
          // rollout, a lost NATS channel): written before the wait, read by the
          // next turn's `checkActiveAgentRun` to re-attach instead of failing a
          // run that is still working.
          markAgentRunAwaitingReply: (sessionId, run) => markAgentRunAwaitingReply(sessionStore, sessionId, run),
          clearAgentRunAwaitingReply: (sessionId) => clearAgentRunAwaitingReply(sessionStore, sessionId),
          callbackSecretRef: { name: config.callbackSecretRefName ?? "", key: config.callbackSecretRefKey },
        }
      : {}),
  });

  // Answers Open WebUI's internal housekeeping completions (title/tags/query
  // generation) directly, bypassing the agent graph -- see server.ts's
  // handleInternalUiTask and isInternalUiTaskRequest.
  const taskCompleter = new OpenAiTaskCompleter();
  // Just-in-time index for consumer-supplied tools (docs/adr/0035), in its own
  // collection so nothing here can touch the catalog collections above. Nothing
  // is upserted at startup (there is no catalog to load — definitions arrive in
  // request bodies), so this only ensures the collection exists.
  const callerToolStore = new QdrantCallerToolStore(
    {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      collection: config.callerToolsQdrantCollection,
      vectorSize: config.qdrantVectorSize,
    },
    embedder,
  );
  await callerToolStore.ensureCollection();
  // Qdrant has no native TTL, so definitions that stopped being sent are swept
  // on a timer. `unref()` so an idle sweep timer never holds the process open
  // during shutdown; it is also cleared explicitly below.
  const callerToolPruneTimer = setInterval(
    () => {
      void callerToolStore
        .prune(config.callerToolTtlSeconds * 1_000)
        // A failed sweep is not worth failing anything else over: the only
        // consequence is that stale definitions live until the next sweep.
        .catch((err: unknown) => console.warn("caller-tool prune failed:", err));
    },
    config.callerToolPruneIntervalSeconds * 1_000,
  );
  callerToolPruneTimer.unref();

  // Which agent loop runs a turn (docs/adr/0036). `langgraph` is the default,
  // so enabling the engine is always an explicit act and this whole block is
  // inert until someone sets AGENT_ENGINE=temporal.
  //
  // Everything else about this process is shared either way: the OpenAI facade,
  // /invoke, identity resolution, RBAC, the credential store, the
  // authorization pre-flight, and both launchers. Only the loop moves.
  let engine: AgentGraphLike = graph;
  if (config.agentEngine === "temporal") {
    if (!config.temporalEngineUrl) {
      throw new Error("AGENT_ENGINE=temporal requires AGENT_TEMPORAL_ENGINE_URL");
    }
    engine = new TemporalEngine({
      baseUrl: config.temporalEngineUrl,
      ...(config.temporalEngineToken ? { token: config.temporalEngineToken } : {}),
      // Reuses the assertion contract rather than trusting a login on an
      // internal hop -- see TemporalEngine's own note.
      ...(config.senderAssertionSecret ? { senderAssertionSecret: config.senderAssertionSecret } : {}),
      // Same forwarded-user resolver `graph`'s resolveIdentity node uses --
      // without it, every CHAT turn on this engine collapses onto the
      // gateway's shared default/bearer identity regardless of which human is
      // chatting. Scoped to this one resolver deliberately -- see
      // TemporalEngineOptions.forwardedUserIdentityResolver's doc comment.
      ...(forwardedUserIdentityResolver ? { forwardedUserIdentityResolver } : {}),
      timeoutMs: config.agentRunTimeoutSeconds * 1_000,
    });
    console.log(`agent engine: temporal (${config.temporalEngineUrl})`);
  } else {
    console.log("agent engine: langgraph (in-process)");
  }

  const invokeServer = new InvokeServer(
    engine,
    sessionStore,
    taskCompleter,
    integrationRouteRegistry,
    agentDelegation?.agentChannel,
    config.senderAssertionSecret,
    callerToolStore,
    config.callerToolTopK,
    config.defaultIdentityLinkFlow,
    invocationStore,
  );
  if (!config.senderAssertionSecret) {
    console.error(
      "WARNING: AGENT_SENDER_ASSERTION_SECRET is not set -- a webhook turn's sender login is trusted from the request " +
        "body without verification. It selects the caller's principal, and therefore which stored credentials the run " +
        "receives (docs/adr/0030). Set it, and integration-gateway's matching GATEWAY_SENDER_ASSERTION_SECRET, to " +
        "require a signed assertion instead.",
    );
  }

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
    connectionWatch?.stop();
    knowledgeBaseWatch?.stop();
    agentWatch?.stop();
    integrationRouteWatch.stop();
    identityProviderWatch.stop();
    if (skillReindexTimer) clearTimeout(skillReindexTimer);
    clearInterval(callerToolPruneTimer);

    // Refuse NEW turns first. Durable invocation records make an answer
    // retrievable from any replica; they do not make a turn whose graph died
    // with this process complete itself. So a caller arriving now is told to
    // retry (503) and reaches the replacement, rather than being handed a 202
    // for a turn that can never finish -- the failure that produced an
    // AgentRun at 04:48:30 against a pod replaced at 04:48:32, its answer
    // stranded behind a poll the new pod 404s.
    invokeServer.beginDraining();

    // Phase 1 -- stop accepting new work, then let in-flight requests finish.
    // This MUST complete before the transports below are torn down: an
    // in-flight chat turn is parked on a NATS subscription (`awaitReply`), so
    // draining that connection in the same step -- as this used to, via a
    // single `Promise.all` over every closer -- destroys the channel the
    // request is waiting on and fails a perfectly healthy agent run. That is
    // what produced a fabricated "produced no reply within <configured
    // bound>ms" on AgentRun 0f97aa3d (run 20:15:36Z, rollout 53s later at
    // 20:16:29Z, run itself succeeded at 20:19:30Z).
    //
    // Bounded, because k8s SIGKILLs at terminationGracePeriodSeconds (30s)
    // regardless: past the deadline we stop waiting and tear down anyway, so
    // a turn that outlives the grace period at least fails the same way it
    // would have, rather than blocking the other closers entirely.
    //
    // A drain window is therefore never enough on its own -- an agent turn takes
    // minutes and this gives it seconds. What keeps the ANSWER is that the run's
    // agent holds its concluding message until acked and the conversation was
    // anchored to the run before the wait began, so the next turn re-attaches
    // and collects it (docs/adr/0033). This drain just lets the turns that can
    // finish, finish.
    const httpDrained = Promise.all([
      invokeServer.close(),
      ...(callbackReceiver ? [callbackReceiver.close()] : []),
    ]).then(
      () => "drained" as const,
      (err: unknown) => {
        console.error("error draining HTTP servers during shutdown:", err);
        return "drained" as const;
      },
    );
    const drainOutcome = await Promise.race([
      httpDrained,
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), config.shutdownDrainMs)),
    ]);
    if (drainOutcome === "deadline") {
      console.error(
        `in-flight requests still running after ${config.shutdownDrainMs}ms; closing transports anyway (they will report a lost channel)`,
      );
    }

    // Phase 2 -- nothing should still be waiting on these.
    const closers: Promise<void>[] = [];
    if (config.natsUrl) {
      // NatsJobReceiver.close() drains the connection.
      closers.push((jobResultReceiver as NatsJobReceiver).close());
    }
    if (agentDelegation) closers.push(agentDelegation.agentChannel.close());
    if (redisSessionStore) closers.push(redisSessionStore.close());
    if (redisInvocationStore) closers.push(redisInvocationStore.close());
    if (redisAgentReplyStore) closers.push(redisAgentReplyStore.close());
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

