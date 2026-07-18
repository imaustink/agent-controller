import * as k8s from "@kubernetes/client-node";
import { CallbackReceiver } from "./callback/receiver.js";
import { config } from "./config.js";
import { AgentRunLauncher } from "./k8s/agentrun-launcher.js";
import { ToolRunLauncher } from "./k8s/toolrun-launcher.js";
import { loadStaticIdentitiesFromEnv, StaticIdentityResolver } from "./rbac/static-identity-resolver.js";
import { CrdCatalogRegistry } from "./registry/crd-catalog-registry.js";
import { GatewayServer } from "./server.js";

/** Process exit code for startup failures — this is a long-lived service. */
const EXIT_STARTUP_FAILURE = 1;

async function main(): Promise<void> {
  if (!config.callbackSecret) {
    console.error("GATEWAY_CALLBACK_SECRET is required");
    process.exit(EXIT_STARTUP_FAILURE);
  }
  if (!config.callbackSecretRefName) {
    console.error(
      "GATEWAY_CALLBACK_SECRET_REF_NAME is required -- launchers reference the callback HMAC secret by k8s Secret name/key (never plaintext in ToolRun/AgentRun CRs)",
    );
    process.exit(EXIT_STARTUP_FAILURE);
  }

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();

  const registry = CrdCatalogRegistry.fromKubeConfig(
    config.namespace,
    config.crdGroup,
    config.crdVersion,
    kubeConfig,
  );
  const callbackSecretRef = {
    name: config.callbackSecretRefName,
    key: config.callbackSecretRefKey,
  };
  const toolRunLauncher = ToolRunLauncher.fromKubeConfig(
    config.crdGroup,
    config.crdVersion,
    callbackSecretRef,
    kubeConfig,
  );
  const agentRunLauncher = AgentRunLauncher.fromKubeConfig(
    config.crdGroup,
    config.crdVersion,
    callbackSecretRef,
    kubeConfig,
  );
  const identities = loadStaticIdentitiesFromEnv(config.staticIdentities);
  const identityResolver = new StaticIdentityResolver(identities);
  const callbackReceiver = new CallbackReceiver(config.callbackSecret);
  const server = new GatewayServer({
    registry,
    identityResolver,
    toolRunLauncher,
    agentRunLauncher,
    jobAwaiter: callbackReceiver,
    callbackBaseUrl: config.callbackBaseUrl,
    runTimeoutSeconds: config.runTimeoutSeconds,
  });

  await callbackReceiver.listen(config.callbackPort);
  await server.listen(config.httpPort);
  console.error(`integration-gateway listening on :${config.httpPort} (callback :${config.callbackPort})`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}; shutting down integration-gateway...`);
    await Promise.allSettled([server.close(), callbackReceiver.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(EXIT_STARTUP_FAILURE);
});
