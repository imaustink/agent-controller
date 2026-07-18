/** Central configuration for the integration gateway container. */
export interface AppConfig {
  /** k8s namespace Tools/Agents/ToolRuns/AgentRuns are read and created in. */
  namespace: string;
  /** API group for the Tool/Agent/ToolRun/AgentRun CRDs. */
  crdGroup: string;
  /** API version for the Tool/Agent/ToolRun/AgentRun CRDs. */
  crdVersion: string;
  /** Consumer-facing HTTP port for POST /fn/:id and GET /fn/runs/:id. */
  httpPort: number;
  /** Separate HTTP callback port for tool/agent terminal events. */
  callbackPort: number;
  /** Base URL tool/agent Jobs use to call back into this gateway. */
  callbackBaseUrl: string;
  /** Shared secret for HMAC-verifying inbound callback bodies. */
  callbackSecret: string;
  /** Name of the k8s Secret containing the callback HMAC secret. */
  callbackSecretRefName: string | undefined;
  /** Key within callbackSecretRefName holding the callback HMAC secret. */
  callbackSecretRefKey: string;
  /** JSON map of dev/test bearer tokens -> identity; see StaticIdentityResolver. */
  staticIdentities: string | undefined;
  /** Default timeout passed to AgentRun.spec.timeoutSeconds in phase 1. */
  runTimeoutSeconds: number;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config: AppConfig = {
  namespace: process.env.GATEWAY_NAMESPACE ?? "default",
  crdGroup: process.env.GATEWAY_CRD_GROUP ?? "core.controller-agent.dev",
  crdVersion: process.env.GATEWAY_CRD_VERSION ?? "v1alpha1",
  httpPort: num(process.env.GATEWAY_HTTP_PORT, 8090),
  callbackPort: num(process.env.GATEWAY_CALLBACK_PORT, 8091),
  callbackBaseUrl: process.env.GATEWAY_CALLBACK_BASE_URL ?? "http://localhost:8091",
  callbackSecret: process.env.GATEWAY_CALLBACK_SECRET ?? "",
  callbackSecretRefName: process.env.GATEWAY_CALLBACK_SECRET_REF_NAME,
  callbackSecretRefKey: process.env.GATEWAY_CALLBACK_SECRET_REF_KEY ?? "secret",
  staticIdentities: process.env.GATEWAY_STATIC_IDENTITIES,
  runTimeoutSeconds: num(process.env.GATEWAY_RUN_TIMEOUT_SECONDS, 600),
};
