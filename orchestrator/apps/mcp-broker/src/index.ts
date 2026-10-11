/**
 * The mcp-broker process (docs/adr/0045).
 *
 * Two jobs in one Deployment, the only component that speaks MCP:
 *
 *   - DISCOVERY (a controller): watch MCPServer CRs, list each server's tools,
 *     publish them to status, and materialize the EXPOSED ones as derived
 *     MCPTool CRs — on load, on change, and on a periodic resync.
 *   - INVOCATION (an HTTP API): proxy one tools/call to a server under the
 *     caller's delegated token.
 *
 * A separate Deployment from agent-orchestrator on purpose: the MCP wire
 * protocol, its sessions and its outbound egress stay out of the deterministic
 * agent loop, which keeps a malformed or hostile server from reaching the loop's
 * process, secrets or cluster identity.
 */
import * as k8s from "@kubernetes/client-node";

import { createMcpBrokerServer } from "./server.js";
import { CrdMCPServerRegistry } from "./crd-mcpserver-registry.js";
import { GROUP, VERSION } from "./mcp-server-resource.js";
import { SdkMcpClient } from "./mcp-client.js";
import { Discovery } from "./discovery.js";
import { MCPToolWriter, type CustomObjectsWriterApi } from "./mcptool-writer.js";
import { MCPServerStatusWriter, type StatusPatcherApi } from "./mcpserver-status.js";
import type { MCPServerBinding } from "./mcpserver-registry.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at startup rather than on the first request: a broker running without
    // its token would reject everything and look like a networking problem.
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const namespace = process.env.NAMESPACE ?? "default";
  const group = process.env.CRD_GROUP ?? GROUP;
  const version = process.env.CRD_VERSION ?? VERSION;
  const port = Number(process.env.PORT ?? 8080);
  const discoveryIntervalMs = Number(process.env.DISCOVERY_INTERVAL_MS ?? 300_000);

  const orchestratorToken = required("ORCHESTRATOR_TOKEN");

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();

  const customObjects = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

  const client = new SdkMcpClient();

  const toolWriter = new MCPToolWriter({
    api: customObjects as unknown as CustomObjectsWriterApi,
    namespace,
    group,
    version,
    onError: (tool, err) => console.error(`Could not write MCPTool ${tool}:`, err),
  });

  const statusWriter = new MCPServerStatusWriter({
    api: customObjects as unknown as StatusPatcherApi,
    namespace,
    group,
    version,
    // Reported, never fatal: the discovery already happened and the tools are
    // already materialized; failing because the status write did not land would
    // throw away real work to protect a status blob.
    onError: (server, err) => console.error(`Could not publish status for MCPServer ${server}:`, err),
  });

  const discovery = new Discovery({
    client,
    toolWriter,
    statusWriter,
    onError: (server, err) => console.error(`Discovery for MCPServer ${server} failed:`, err),
  });

  const registry = CrdMCPServerRegistry.fromKubeConfig(namespace, group, version, kubeConfig, {
    // A changed server is re-discovered immediately; the periodic resync below
    // is only the backstop for a change the watch never delivered.
    onChange: (binding: MCPServerBinding) => void discovery.runServer(binding),
    onError: (server, err) => console.error(`MCPServer ${server} could not be bound:`, err),
  });

  await registry.loadAll();
  registry.watch();
  console.log(`bound ${registry.list().length} MCPServer(s) in ${namespace}`);

  // Initial sweep after load, then on the resync interval.
  await discovery.runAll(registry.list());
  const resync = setInterval(() => {
    void discovery.runAll(registry.list());
  }, discoveryIntervalMs);
  // Do not keep the event loop alive for the timer alone.
  resync.unref?.();

  const server = createMcpBrokerServer({ auth: { orchestratorToken }, registry, client });
  server.listen(port, () => console.log(`mcp-broker listening on ${port}`));

  const shutdown = () => {
    clearInterval(resync);
    registry.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((err: unknown) => {
  console.error("mcp-broker failed to start:", err);
  process.exit(1);
});
