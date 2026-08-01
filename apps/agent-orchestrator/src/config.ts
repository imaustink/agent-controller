import { randomUUID } from "node:crypto";

/** Central configuration for the orchestrator container. */
export interface AppConfig {
  /** k8s namespace tool/sub-agent Jobs are launched into. */
  namespace: string;
  /** API group for the Tool/Skill/ToolRun CRDs (ADR 0010), e.g. `core.controller-agent.dev`. */
  crdGroup: string;
  /** API version for the Tool/Skill/ToolRun CRDs (ADR 0010), e.g. `v1alpha1`. */
  crdVersion: string;
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
  qdrantCollection: string;
  qdrantVectorSize: number;
  /** Collection name for the skills catalog (docs/adr/0008) - same Qdrant instance, separate collection. */
  skillsQdrantCollection: string;
  /** Collection name for the agent catalog, same Qdrant instance, separate collection from tools/skills. */
  agentsQdrantCollection: string;
  /**
   * Collection name for consumer-supplied tools (docs/adr/0035) — same Qdrant
   * instance, deliberately its OWN collection so a caller's ephemeral function
   * definitions can never enter the tool catalog's candidate set or affect its
   * recall. Points are keyed by content hash, which makes the collection an
   * embedding cache: an identical definition is embedded once, ever.
   */
  callerToolsQdrantCollection: string;
  /**
   * Max consumer-supplied tools that may reach the action planner
   * (docs/adr/0035 §3). Doubles as the threshold below which the caller-tool
   * index is skipped ENTIRELY: with this many tools or fewer there is nothing to
   * prune, so a caller sending a handful pays no embedding or Qdrant cost at all.
   */
  callerToolTopK: number;
  /**
   * How long an unused caller-tool definition survives before being swept
   * (Qdrant has no native TTL, so this is a periodic `prune`). Any turn that
   * references a definition refreshes it, so this only ages out tool sets that
   * genuinely stopped being sent.
   */
  callerToolTtlSeconds: number;
  /** How often to run that sweep. */
  callerToolPruneIntervalSeconds: number;
  embeddingModel: string;
  selectionModel: string;
  /** Max candidate skills retrieved per request, before skill selection (docs/adr/0008). */
  skillTopK: number;
  /** Max candidate agents retrieved per request, before delegate selection (mirrors skillTopK). */
  agentTopK: number;
  /**
   * Bounds an AgentRun's activeDeadlineSeconds — the only wall-clock ceiling
   * on a run, and a backstop against a wedged pod holding node resources
   * rather than a realistic task budget. A real coding task (clone, run
   * Claude, open a PR, iterate on review feedback) can legitimately take
   * hours, so this is deliberately generous; what actually ends a stuck run
   * is `agentIdleTimeoutSeconds` below. No longer coupled to the
   * orchestrator's own wait — see `agentAwaitReplyIdleTimeoutMs` in graph.ts.
   */
  agentRunTimeoutSeconds: number;
  /**
   * How long an agent may go completely silent — no reply, no progress, no
   * event, no warning — before the orchestrator stops waiting on its turn.
   * Bounds SILENCE, not total duration: any up-message resets it, so a run
   * that narrates is never cut off however long it takes. This, not
   * `agentRunTimeoutSeconds`, is what actually ends a stuck run; the wall-clock
   * ceiling is only a backstop for a pod that is wedged AND still chattering.
   * See `DEFAULT_IDLE_TIMEOUT_MS` in agents/nats-agent-channel.ts for why 10
   * minutes is a safe floor given real agent narration cadences.
   */
  agentIdleTimeoutSeconds: number;
  /**
   * On SIGTERM, how long to let in-flight HTTP requests finish before tearing
   * down the NATS/Redis connections they depend on. Must stay under the pod's
   * `terminationGracePeriodSeconds` (30s today) or k8s SIGKILLs mid-drain and
   * the wait buys nothing.
   */
  shutdownDrainMs: number;
  /**
   * Sliding idle TTL (seconds) for conversation-session records — how long
   * a chat's active skill is remembered between turns (docs/adr/0012).
   */
  sessionTtlSeconds: number;
  /** Hard cap on stored conversation sessions; least-recently-updated evicted first (docs/adr/0012). */
  sessionMaxEntries: number;
  /**
   * Redis URL for the conversation-session store (docs/adr/0016). When set,
   * the orchestrator uses `RedisSessionStore` instead of `InMemorySessionStore`
   * so sessions survive restarts and are shared across replicas. Leave unset
   * for the single-replica in-memory default.
   */
  redisUrl: string | undefined;
  /**
   * HTTP port the callback receiver listens on for Job -> orchestrator
   * results. Deliberately separate from `httpPort` below so a NetworkPolicy
   * can expose them differently: this one only needs to be reachable from
   * Job pods in-cluster, never from outside callers (ADR 0006).
   */
  callbackPort: number;
  /** Base URL Jobs use to reach the callback receiver, e.g. a Service DNS name. */
  callbackBaseUrl: string;
  /** Shared secret for HMAC-signing/verifying callback bodies (used by this process itself to verify inbound callbacks). */
  callbackSecret: string;
  /**
   * Name of the k8s Secret containing the callback HMAC secret, referenced
   * (never copied as plaintext) by ToolRun CRs so the Go core-controller can
   * wire it into the launched Job via `secretKeyRef` (ADR 0010).
   */
  callbackSecretRefName: string | undefined;
  /** Key within `callbackSecretRefName` holding the callback HMAC secret. */
  callbackSecretRefKey: string;
  /** HTTP port the consumer-facing invoke API listens on (ADR 0006). */
  httpPort: number;
  /**
   * Shared secret integration-gateway signs its sender assertions with
   * (docs/adr/0030 §6). When set, a webhook turn's sender login is accepted
   * ONLY from a verified assertion; when unset, the unsigned request-body
   * field is trusted (pre-assertion behaviour, warned about at startup).
   */
  senderAssertionSecret: string;
  /**
   * Directory holding one `<runtime>.sock` per LocalTool executor sidecar
   * (ADR 0014), shared with the sidecars via an emptyDir. The orchestrator
   * POSTs run requests here over unix sockets — never over the network.
   */
  localToolSocketDir: string;
  /** Fallback per-execution timeout (seconds) for LocalTools that set none. */
  localToolTimeoutSeconds: number;
  /**
   * Which `IdentityResolver` to build (index.ts): `"static"` (default) uses
   * `staticIdentities` below as the only resolver. `"oidc"` verifies caller
   * bearer tokens as signed JWTs against `oidcIssuer`'s JWKS (see
   * OidcIdentityResolver) -- the real IdP integration deferred by ADR 0004.
   * If `staticIdentities` is also set while this is "oidc", tokens that fail
   * oidc verification fall back to that static map (CompositeIdentityResolver)
   * instead of being rejected outright -- see staticIdentities below.
   */
  identityResolverKind: "static" | "oidc";
  /**
   * JSON map of bearer tokens -> identity; see StaticIdentityResolver. When
   * identityResolverKind is "static", this is the only resolver. When
   * identityResolverKind is "oidc" and this is also set, it becomes a
   * fallback CompositeIdentityResolver consults for tokens that fail oidc
   * verification -- for callers that can't present a real, refreshable OIDC
   * token (e.g. Open WebUI's static API-key field).
   */
  staticIdentities: string | undefined;
  /** Expected JWT `iss` claim. Required when identityResolverKind is "oidc". */
  oidcIssuer: string | undefined;
  /** JWKS endpoint used to verify JWT signatures. Required when identityResolverKind is "oidc". */
  oidcJwksUri: string | undefined;
  /** Expected JWT `aud` claim. Leave unset to skip audience verification. */
  oidcAudience: string | undefined;
  /** Dot-path to the roles claim in the verified JWT, e.g. "roles" or "realm_access.roles" (Keycloak). */
  oidcRolesClaim: string;
  /**
   * NATS server URL for the tool-result channel (and the sub-agent channel).
   * When set, tool Jobs receive their result via NATS (`NatsJobReceiver`) instead
   * of the HTTP callback receiver (`CallbackReceiver`). When absent, the HTTP
   * callback path is used (backward-compatible default).
   */
  natsUrl: string | undefined;
  /**
   * Max candidate tools retrieved when attempting a direct fallback tool call
   * for a turn matching no Skill/Agent, before falling through to a bare
   * best-effort LLM answer (there is no hardcoded fallback agent). Mirrors
   * skillTopK/agentTopK.
   */
  fallbackToolTopK: number;
  /**
   * Base URL of apps/integration-gateway's internal identity-link API
   * (OAuth Device Flow for per-caller GitHub identity). Optional along with
   * `identityLinkGatewayToken` below -- absent means `identityLinkGateway`
   * stays unconfigured (index.ts), so any Agent declaring `identityProviders`
   * fails closed with a clear per-turn error rather than crashing startup;
   * deployments that never delegate to an identity-requiring Agent can
   * ignore this feature entirely.
   */
  identityLinkGatewayUrl: string | undefined;
  /** Bearer token this orchestrator authenticates to the identity-link API with. */
  identityLinkGatewayToken: string | undefined;
  /**
   * Shared HS256 secret matching Open WebUI's `FORWARD_USER_INFO_HEADER_JWT_SECRET`,
   * used to verify its per-request `X-OpenWebUI-User-Jwt` header
   * (`OpenWebUiForwardedUserResolver`). Open WebUI's `Authorization` bearer
   * token is a single static value shared by every one of its users, so
   * resolving identity from it alone collapses every human into one shared
   * subject -- this lets each Open WebUI user resolve to their own subject
   * instead. Optional: absent -> the chat-completions path falls back to the
   * shared-subject static/OIDC resolver (pre-existing behavior).
   */
  openWebUiUserJwtSecret: string | undefined;
  /**
   * RBAC roles (this system's vocabulary, e.g. `reader`/`writer` -- whatever
   * Tool/Agent CRs declare in `allowedRoles`) granted to every caller
   * `OpenWebUiForwardedUserResolver` resolves. Comma-separated. Defaults to
   * the same `reader,writer` the old shared `AGENT_STATIC_IDENTITIES` entry
   * granted every Open WebUI user, so switching to per-user subjects doesn't
   * also silently change what any of them can see/do.
   */
  openWebUiUserRoles: string[];
  requestId: string;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config: AppConfig = {
  namespace: process.env.AGENT_NAMESPACE ?? "default",
  crdGroup: process.env.AGENT_CRD_GROUP ?? "core.controller-agent.dev",
  crdVersion: process.env.AGENT_CRD_VERSION ?? "v1alpha1",
  qdrantUrl: process.env.AGENT_QDRANT_URL ?? "http://localhost:6333",
  qdrantApiKey: process.env.AGENT_QDRANT_API_KEY,
  qdrantCollection: process.env.AGENT_QDRANT_COLLECTION ?? "tools",
  qdrantVectorSize: num(process.env.AGENT_QDRANT_VECTOR_SIZE, 1536),
  skillsQdrantCollection: process.env.AGENT_QDRANT_SKILLS_COLLECTION ?? "skills",
  agentsQdrantCollection: process.env.AGENT_QDRANT_AGENTS_COLLECTION ?? "agents",
  callerToolsQdrantCollection: process.env.AGENT_QDRANT_CALLER_TOOLS_COLLECTION ?? "caller_tools",
  callerToolTopK: num(process.env.AGENT_CALLER_TOOL_TOP_K, 5),
  callerToolTtlSeconds: num(process.env.AGENT_CALLER_TOOL_TTL_SECONDS, 604_800), // 7 days
  callerToolPruneIntervalSeconds: num(process.env.AGENT_CALLER_TOOL_PRUNE_INTERVAL_SECONDS, 3_600),
  embeddingModel: process.env.AGENT_EMBEDDING_MODEL ?? "text-embedding-3-small",
  selectionModel: process.env.AGENT_SELECTION_MODEL ?? "gpt-4o-2024-08-06",
  skillTopK: num(process.env.AGENT_SKILL_TOP_K, 3),
  agentTopK: num(process.env.AGENT_TOP_K, 3),
  agentRunTimeoutSeconds: num(process.env.AGENT_RUN_TIMEOUT_SECONDS, 28800), // 8h wall-clock backstop
  agentIdleTimeoutSeconds: num(process.env.AGENT_IDLE_TIMEOUT_SECONDS, 600), // 10m of silence
  shutdownDrainMs: num(process.env.AGENT_SHUTDOWN_DRAIN_MS, 25_000), // under the 30s grace period
  sessionTtlSeconds: num(process.env.AGENT_SESSION_TTL_SECONDS, 1800),
  sessionMaxEntries: num(process.env.AGENT_SESSION_MAX_ENTRIES, 1000),
  redisUrl: process.env.AGENT_REDIS_URL,
  callbackPort: num(process.env.AGENT_CALLBACK_PORT, 8080),
  callbackBaseUrl: process.env.AGENT_CALLBACK_BASE_URL ?? "http://localhost:8080",
  httpPort: num(process.env.AGENT_HTTP_PORT, 8081),
  senderAssertionSecret: process.env.AGENT_SENDER_ASSERTION_SECRET ?? "",
  callbackSecret: process.env.AGENT_CALLBACK_SECRET ?? "",
  callbackSecretRefName: process.env.AGENT_CALLBACK_SECRET_REF_NAME,
  callbackSecretRefKey: process.env.AGENT_CALLBACK_SECRET_REF_KEY ?? "AGENT_CALLBACK_SECRET",
  localToolSocketDir: process.env.AGENT_LOCALTOOL_SOCKET_DIR ?? "/run/localtool",
  localToolTimeoutSeconds: num(process.env.AGENT_LOCALTOOL_TIMEOUT_SECONDS, 30),
  identityResolverKind: process.env.AGENT_IDENTITY_RESOLVER === "oidc" ? "oidc" : "static",
  staticIdentities: process.env.AGENT_STATIC_IDENTITIES,
  oidcIssuer: process.env.AGENT_OIDC_ISSUER,
  oidcJwksUri: process.env.AGENT_OIDC_JWKS_URI,
  oidcAudience: process.env.AGENT_OIDC_AUDIENCE,
  oidcRolesClaim: process.env.AGENT_OIDC_ROLES_CLAIM ?? "roles",
  natsUrl: process.env.AGENT_NATS_URL,
  fallbackToolTopK: num(process.env.AGENT_FALLBACK_TOOL_TOP_K, 3),
  identityLinkGatewayUrl: process.env.IDENTITY_LINK_GATEWAY_URL,
  identityLinkGatewayToken: process.env.IDENTITY_LINK_GATEWAY_TOKEN,
  openWebUiUserJwtSecret: process.env.AGENT_OPENWEBUI_USER_JWT_SECRET,
  openWebUiUserRoles: (process.env.AGENT_OPENWEBUI_USER_ROLES ?? "reader,writer")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0),
  requestId: process.env.AGENT_REQUEST_ID ?? randomUUID(),
};
