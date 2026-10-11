import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The REAL broker, driven by the REAL engine client — the two halves of MCP
// support that live in different packages and must agree with nothing between
// them but a URL, a header and two JSON shapes.
import { createMcpBrokerServer, DELEGATED_TOKEN_HEADER } from "../../orchestrator/apps/mcp-broker/src/server.js";
import { StaticMCPServerRegistry } from "../../orchestrator/apps/mcp-broker/src/mcpserver-registry.js";
import { Discovery } from "../../orchestrator/apps/mcp-broker/src/discovery.js";
import { MCPToolWriter, type CustomObjectsWriterApi } from "../../orchestrator/apps/mcp-broker/src/mcptool-writer.js";
import { MCPServerStatusWriter, type StatusPatcherApi } from "../../orchestrator/apps/mcp-broker/src/mcpserver-status.js";
import {
  McpTransportError,
  type DiscoveredTool,
  type McpClient,
  type ToolCallResult,
} from "../../orchestrator/apps/mcp-broker/src/mcp-client.js";
import {
  GROUP,
  SERVER_LABEL,
  VERSION,
  type MCPServerCustomResource,
  type MCPToolCustomResource,
} from "../../orchestrator/apps/mcp-broker/src/mcp-server-resource.js";

import { MCPBrokerClient } from "../../orchestrator/apps/agent-orchestrator/src/mcp/mcp-broker-client.js";
import { toMCPToolDescriptor } from "../../orchestrator/apps/agent-orchestrator/src/registry/crd-mcp-tool-registry.js";
import type { ToolDescriptor } from "../../orchestrator/apps/agent-orchestrator/src/tool-descriptor.js";

/**
 * MCP tool support across its three components and two languages, driven against
 * the REAL broker (ADR 0045). The engine client, the broker server and the Go
 * dispatch activity are three implementations of one contract — a URL, an
 * `x-delegated-token` header, a `{arguments}` request and a `{result,isError}`
 * reply — and nothing but agreement makes a tool call reach a server and come
 * back. This is the same guard `broker-contract.e2e.ts` keeps over the
 * connection-broker, for the same reason: every past break in this repo was a
 * cross-component rename that a unit suite, mocking the other half, waved
 * through. It needs no cluster: the MCP server is a fake and the question is
 * purely whether the halves of this repo agree.
 *
 * Four boundaries, each exercised with the real code on both sides:
 *   1. The engine client ↔ the broker server (route, auth, fail-closed, errors).
 *   2. Discovery's WRITE of a derived MCPTool ↔ the engine registry's READ of it.
 *   3. The existence rule (§6) through the real writer.
 *   4. The Go engine addresses the same route and reply the TS client does.
 */

const NAMESPACE = "e2e";
const ORCHESTRATOR_TOKEN = "broker-secret";
const SERVICE_TOKEN = "discovery-service-cred";
const DELEGATED = "alice-delegated-token";
const SERVER = "github-mcp";

/** The remote tools the fake MCP server advertises; mutable for the §6 pass. */
interface FakeState {
  tools: DiscoveredTool[];
  reachable: boolean;
  calls: Array<{ url: string; token?: string; name: string; arguments: Record<string, unknown> }>;
}

/**
 * A fake MCP server, injected where the real broker would hold an SdkMcpClient.
 * It records what the broker asked and with which token — which is how a test
 * proves the broker spent the CALLER's token, not the service credential.
 */
function fakeMcpClient(state: FakeState): McpClient {
  return {
    async listTools(opts) {
      if (!state.reachable) throw new McpTransportError(`unreachable: ${opts.url}`);
      return state.tools;
    },
    async callTool(opts): Promise<ToolCallResult> {
      state.calls.push(opts);
      if (opts.name === "explode") {
        return { content: [{ type: "text", text: "the repo does not exist" }], isError: true };
      }
      return {
        content: [{ type: "text", text: `echo:${JSON.stringify(opts.arguments)}` }],
        isError: false,
      };
    },
  };
}

/** An in-memory stand-in for the custom-objects API the broker writes through. */
class FakeK8s implements CustomObjectsWriterApi, StatusPatcherApi {
  readonly tools = new Map<string, MCPToolCustomResource>();
  readonly statuses = new Map<string, Record<string, unknown>>();

  async listNamespacedCustomObject(): Promise<{ items?: unknown[] }> {
    return { items: [...this.tools.values()] };
  }
  async createNamespacedCustomObject(args: { body: unknown }): Promise<unknown> {
    const body = args.body as MCPToolCustomResource;
    this.tools.set(body.metadata.name, body);
    return body;
  }
  async patchNamespacedCustomObject(args: { name: string; body: unknown }): Promise<unknown> {
    const patch = args.body as MCPToolCustomResource;
    this.tools.set(args.name, { ...this.tools.get(args.name), ...patch } as MCPToolCustomResource);
    return patch;
  }
  async deleteNamespacedCustomObject(args: { name: string }): Promise<unknown> {
    this.tools.delete(args.name);
    return {};
  }
  async patchNamespacedCustomObjectStatus(args: { name: string; body: unknown }): Promise<unknown> {
    this.statuses.set(args.name, (args.body as { status: Record<string, unknown> }).status);
    return {};
  }
}

/** An MCPServer CR the broker acts on. */
function serverCR(opts: {
  identityProviders?: string[];
  exposure?: MCPServerCustomResource["spec"]["exposure"];
}): MCPServerCustomResource {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "MCPServer",
    metadata: { name: SERVER, namespace: NAMESPACE, uid: "uid-1", generation: 1 },
    spec: {
      transport: "streamable-http",
      url: "http://fake-mcp.e2e.svc:8080/mcp",
      identityProviders: opts.identityProviders,
      exposure: opts.exposure,
    },
  };
}

/** The engine-side descriptor for a materialized MCP tool. */
function mcpToolDescriptor(remoteToolName: string, identityProviders?: string[]): ToolDescriptor {
  return {
    id: `mcp-${SERVER}-${remoteToolName}`,
    name: `mcp-${SERVER}-${remoteToolName}`,
    description: "…",
    allowedRoles: ["engineering"],
    identityProviders,
    mcpExec: { serverRef: SERVER, remoteToolName },
  } as ToolDescriptor;
}

/** A credential resolver that hands back a fixed token, or none when unlinked. */
function resolver(token: string | undefined) {
  return {
    delegatedToken: async () => ({ token: token ?? "", principals: [] as string[] }),
    delegatedTokens: async (_subject: string, providers: string[]) =>
      new Map(providers.map((p) => [p, { token: token ?? "", principals: [] as string[] }])),
  };
}

const caller = { subject: "openwebui:alice" };

describe("the engine client and the broker server agree", () => {
  let server: Server;
  let brokerUrl: string;
  let state: FakeState;

  const exposure = [
    { remoteToolName: "search_issues", allowedRoles: ["engineering"] },
    { remoteToolName: "explode", allowedRoles: ["engineering"] },
  ];

  function startBroker(identityProviders: string[] | undefined): void {
    server = createMcpBrokerServer({
      auth: { orchestratorToken: ORCHESTRATOR_TOKEN },
      registry: new StaticMCPServerRegistry([
        { name: SERVER, cr: serverCR({ identityProviders, exposure }), serviceToken: SERVICE_TOKEN },
      ]),
      client: fakeMcpClient(state),
    });
  }

  beforeEach(() => {
    state = {
      reachable: true,
      calls: [],
      tools: [
        { name: "search_issues", description: "Search issues", inputSchema: { type: "object" } },
        { name: "explode", description: "Always errors" },
      ],
    };
  });

  afterAll(() => server?.close());

  async function listen(): Promise<void> {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    brokerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("proxies a call through the route the broker serves, carrying the caller's token", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(DELEGATED),
    });

    const out = await client.call(
      mcpToolDescriptor("search_issues", ["github"]),
      `{"query":"is:open"}`,
      caller,
    );

    expect(out.needsLink).toBeFalsy();
    expect(out.result).toBe(`echo:${JSON.stringify({ query: "is:open" })}`);
    // The broker spent the CALLER's delegated token upstream — never the
    // discovery/service credential (ADR 0045 §5).
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({
      token: DELEGATED,
      name: "search_issues",
      arguments: { query: "is:open" },
    });
  });

  it("fails closed when the caller has not linked, never calling the server", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(undefined), // unlinked
    });

    const out = await client.call(mcpToolDescriptor("search_issues", ["github"]), `{}`, caller);

    expect(out.needsLink).toBe(true);
    expect(out.result).toMatch(/link the account/i);
    expect(state.calls, "the broker is never reached with a fallback credential").toHaveLength(0);
  });

  it("spends the service credential, and sends no delegated header, for a no-identity server", async () => {
    startBroker(undefined); // server declares no identityProviders
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(DELEGATED),
    });

    const out = await client.call(mcpToolDescriptor("search_issues"), `{}`, caller);

    expect(out.result).toContain("echo:");
    expect(state.calls[0]!.token, "a no-identity server runs on the service credential").toBe(
      SERVICE_TOKEN,
    );
  });

  it("returns a tool-level error as prose, not a thrown turn", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(DELEGATED),
    });

    const out = await client.call(mcpToolDescriptor("explode", ["github"]), `{}`, caller);

    // isError travels back as the flattened text the model can act on.
    expect(out.result).toContain("the repo does not exist");
    expect(out.needsLink).toBeFalsy();
  });

  it("refuses an unexposed tool with a 404 the client surfaces as prose", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(DELEGATED),
    });

    // Advertised by the server but NOT in the exposure map → the broker refuses.
    const out = await client.call(mcpToolDescriptor("delete_repo", ["github"]), `{}`, caller);

    expect(out.result).toContain("refused that call (404)");
    expect(state.calls, "an unexposed tool never reaches the server").toHaveLength(0);
  });

  it("refuses an unknown server with a 404", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: ORCHESTRATOR_TOKEN,
      credentials: resolver(DELEGATED),
    });

    const tool = mcpToolDescriptor("search_issues", ["github"]);
    (tool.mcpExec as { serverRef: string }).serverRef = "no-such-server";

    const out = await client.call(tool, `{}`, caller);
    expect(out.result).toContain("refused that call (404)");
  });

  it("rejects a bad broker token with a 401 the client surfaces as prose", async () => {
    startBroker(["github"]);
    await listen();
    const client = new MCPBrokerClient({
      brokerUrl,
      brokerToken: "wrong-token",
      credentials: resolver(DELEGATED),
    });

    const out = await client.call(mcpToolDescriptor("search_issues", ["github"]), `{}`, caller);
    expect(out.result).toContain("refused that call (401)");
  });
});

describe("discovery's write and the engine's read agree", () => {
  const exposure = [
    { remoteToolName: "search_issues", allowedRoles: ["engineering", "support"], tier: "standard" },
    { remoteToolName: "secret_op", allowedRoles: ["engineering"], hidden: true },
    // Exposed but the server does not advertise it — materializes nothing.
    { remoteToolName: "ghost_tool", allowedRoles: ["engineering"] },
    // Advertised but withdrawn — in discoveredTools as exposed:false, no CR.
    { remoteToolName: "list_repos", expose: false, allowedRoles: ["engineering"] },
  ];

  function discovery(k8s: FakeK8s, client: McpClient): Discovery {
    return new Discovery({
      client,
      toolWriter: new MCPToolWriter({ api: k8s, namespace: NAMESPACE, group: GROUP, version: VERSION }),
      statusWriter: new MCPServerStatusWriter({
        api: k8s,
        namespace: NAMESPACE,
        group: GROUP,
        version: VERSION,
        now: () => new Date("2026-10-02T00:00:00Z"),
      }),
    });
  }

  function liveTools(): DiscoveredTool[] {
    return [
      { name: "search_issues", description: "Search issues", inputSchema: { type: "object" } },
      { name: "secret_op", description: "Privileged" },
      { name: "list_repos", description: "List repositories" },
    ];
  }

  it("materializes only exposed + live tools, sourcing each field correctly", async () => {
    const k8s = new FakeK8s();
    const state: FakeState = { reachable: true, calls: [], tools: liveTools() };
    const server = serverCR({ identityProviders: ["github"], exposure });

    await discovery(k8s, fakeMcpClient(state)).runServer({
      name: SERVER,
      cr: server,
      serviceToken: SERVICE_TOKEN,
    });

    // search_issues and secret_op are materialized; ghost_tool (not advertised)
    // and list_repos (expose:false) are not.
    expect([...k8s.tools.keys()].sort()).toEqual([
      `mcp-${SERVER}-search_issues`.replace(/_/g, "-"),
      `mcp-${SERVER}-secret_op`.replace(/_/g, "-"),
    ]);

    const search = k8s.tools.get(`mcp-${SERVER}-search-issues`)!;
    // description/inputSchema from the LIVE tool; roles/tier from the EXPOSURE;
    // identityProviders from the SERVER.
    expect(search.spec).toMatchObject({
      serverRef: SERVER,
      remoteToolName: "search_issues",
      description: "Search issues",
      inputSchema: JSON.stringify({ type: "object" }),
      allowedRoles: ["engineering", "support"],
      tier: "standard",
      identityProviders: ["github"],
    });
    // Owned by its server (cascade delete) and labelled (listable).
    expect(search.metadata.ownerReferences?.[0]).toMatchObject({ kind: "MCPServer", name: SERVER, controller: true });
    expect(search.metadata.labels?.[SERVER_LABEL]).toBe(SERVER);

    // A hidden exposure carries hidden through.
    expect(k8s.tools.get(`mcp-${SERVER}-secret-op`)!.spec.hidden).toBe(true);

    // The status is a REPORT of everything advertised, each marked exposed per
    // the map — a grant of nothing.
    const status = k8s.statuses.get(SERVER) as {
      discoveredTools: Array<{ name: string; exposed: boolean }>;
      exposedTools: number;
    };
    expect(status.exposedTools).toBe(2);
    const exposedByName = new Map(status.discoveredTools.map((t) => [t.name, t.exposed]));
    expect(exposedByName.get("search_issues")).toBe(true);
    expect(exposedByName.get("list_repos")).toBe(false); // advertised, withdrawn
    expect(exposedByName.has("secret_op")).toBe(true);

    // The engine READS exactly what the broker WROTE: the derived CR turns into a
    // dispatchable descriptor with the right coordinates and identity gate.
    const descriptor = toMCPToolDescriptor(search as unknown as Parameters<typeof toMCPToolDescriptor>[0]);
    expect(descriptor).toBeDefined();
    expect(descriptor!.mcpExec).toEqual({
      serverRef: SERVER,
      remoteToolName: "search_issues",
      inputSchema: JSON.stringify({ type: "object" }),
    });
    expect(descriptor!.allowedRoles).toEqual(["engineering", "support"]);
    expect(descriptor!.identityProviders).toEqual(["github"]);
    expect(toMCPToolDescriptor(k8s.tools.get(`mcp-${SERVER}-secret-op`)! as never)!.hidden).toBe(true);
  });

  it("deletes a materialized tool the server stops advertising (the existence rule §6)", async () => {
    const k8s = new FakeK8s();
    const state: FakeState = { reachable: true, calls: [], tools: liveTools() };
    const server = serverCR({ identityProviders: ["github"], exposure });
    const disco = discovery(k8s, fakeMcpClient(state));

    await disco.runServer({ name: SERVER, cr: server, serviceToken: SERVICE_TOKEN });
    expect(k8s.tools.has(`mcp-${SERVER}-search-issues`)).toBe(true);

    // The server drops search_issues from its live list; the next pass removes
    // the derived tool rather than leaving a tombstone that fails when invoked.
    state.tools = state.tools.filter((t) => t.name !== "search_issues");
    await disco.runServer({ name: SERVER, cr: server, serviceToken: SERVICE_TOKEN });

    expect(k8s.tools.has(`mcp-${SERVER}-search-issues`)).toBe(false);
    expect(k8s.tools.has(`mcp-${SERVER}-secret-op`), "the still-live tool stays").toBe(true);
  });

  it("marks a server Degraded and retains its tools when it is unreachable", async () => {
    const k8s = new FakeK8s();
    const state: FakeState = { reachable: true, calls: [], tools: liveTools() };
    const server = serverCR({ identityProviders: ["github"], exposure });
    const disco = discovery(k8s, fakeMcpClient(state));

    await disco.runServer({ name: SERVER, cr: server, serviceToken: SERVICE_TOKEN });
    const before = new Set(k8s.tools.keys());
    expect(before.size).toBe(2);

    // Unreachable is "we do not know", not "nothing exists": the tools stay.
    state.reachable = false;
    await disco.runServer({ name: SERVER, cr: server, serviceToken: SERVICE_TOKEN });

    expect(new Set(k8s.tools.keys())).toEqual(before);
    const status = k8s.statuses.get(SERVER) as { conditions: Array<{ type: string; status: string }> };
    expect(status.conditions[0]).toMatchObject({ type: "Ready", status: "False" });
  });
});

/**
 * The Go engine cannot be driven from here, so its dispatch path is read.
 *
 * Crude on purpose, exactly as `broker-contract.e2e.ts` reads the Go corpus
 * broker: `mcptool.go` is the Go twin of `MCPBrokerClient` and has to address a
 * TypeScript server, with nothing between them but this convention. The string
 * IS the contract; the alternative to checking it is not checking it.
 */
describe("the Go engine addresses the same broker route and reply", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const mcptoolGo = readFileSync(
    join(repoRoot, "orchestrator/engines/temporal/internal/temporal/activities/mcptool.go"),
    "utf8",
  );

  it("builds the /servers/:server/tools/:tool/call route the broker serves", () => {
    expect(mcptoolGo).toContain("/servers/");
    expect(mcptoolGo).toContain("/tools/");
    expect(mcptoolGo).toContain("/call");
  });

  it("forwards the caller's token in the x-delegated-token header", () => {
    expect(mcptoolGo).toContain("x-delegated-token");
  });

  it("reads the broker's {result,isError} reply", () => {
    expect(mcptoolGo).toMatch(/json:"result"/);
    expect(mcptoolGo).toMatch(/json:"isError"/);
  });

  it("fails closed on a missing delegated token rather than falling back", () => {
    // A NeedsLink path keyed on IdentityProviders, like the TS client's.
    expect(mcptoolGo).toContain("IdentityProviders");
    expect(mcptoolGo).toMatch(/NeedsLink/);
  });
});
