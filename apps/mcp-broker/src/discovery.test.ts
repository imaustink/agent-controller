import { beforeEach, describe, expect, it } from "vitest";

import { Discovery } from "./discovery.js";
import { McpTransportError, type DiscoveredTool, type McpClient, type ToolCallResult } from "./mcp-client.js";
import { MCPToolWriter } from "./mcptool-writer.js";
import { MCPServerStatusWriter } from "./mcpserver-status.js";
import {
  catalogIdFor,
  MCPTOOL_PLURAL,
  SERVER_LABEL,
  type MCPServerCustomResource,
  type MCPToolCustomResource,
} from "./mcp-server-resource.js";
import type { MCPServerBinding } from "./mcpserver-registry.js";

// The materialized id for the server+tool used throughout — derived, not
// hardcoded, since catalogIdFor hashes a lossy remote name (search_issues) to
// keep ids injective.
const SEARCH_ISSUES_ID = catalogIdFor("github-mcp", {
  remoteToolName: "search_issues",
  allowedRoles: [],
});

/**
 * An in-memory stand-in for the custom-objects API — no network, no cluster.
 * Holds both the MCPTool store (for the writer) and the last status patch per
 * server (for the status writer), since both go through one client in process.
 */
class FakeK8s {
  readonly tools = new Map<string, MCPToolCustomResource>();
  readonly status = new Map<string, Record<string, unknown>>();

  async listNamespacedCustomObject(args: { plural: string }): Promise<{ items?: unknown[] }> {
    if (args.plural !== MCPTOOL_PLURAL) return { items: [] };
    return { items: [...this.tools.values()] };
  }

  async createNamespacedCustomObject(args: { body: unknown }): Promise<unknown> {
    const tool = args.body as MCPToolCustomResource;
    if (this.tools.has(tool.metadata.name)) {
      throw new Error(`already exists: ${tool.metadata.name}`);
    }
    this.tools.set(tool.metadata.name, tool);
    return tool;
  }

  async patchNamespacedCustomObject(args: { name: string; body: unknown }): Promise<unknown> {
    const existing = this.tools.get(args.name);
    if (!existing) throw new Error(`not found: ${args.name}`);
    const patch = args.body as Partial<MCPToolCustomResource>;
    const merged: MCPToolCustomResource = {
      ...existing,
      metadata: { ...existing.metadata, ...(patch.metadata ?? {}) },
      spec: { ...existing.spec, ...(patch.spec ?? {}) },
    };
    this.tools.set(args.name, merged);
    return merged;
  }

  async deleteNamespacedCustomObject(args: { name: string }): Promise<unknown> {
    this.tools.delete(args.name);
    return {};
  }

  async patchNamespacedCustomObjectStatus(args: { name: string; body: unknown }): Promise<unknown> {
    const body = args.body as { status: Record<string, unknown> };
    this.status.set(args.name, body.status);
    return {};
  }
}

/** A fake MCP client: returns a fixed inventory, or throws to simulate unreachable. */
class FakeMcpClient implements McpClient {
  constructor(
    private readonly tools: DiscoveredTool[] | (() => never),
  ) {}

  async listTools(): Promise<DiscoveredTool[]> {
    if (typeof this.tools === "function") this.tools();
    return this.tools as DiscoveredTool[];
  }

  async callTool(): Promise<ToolCallResult> {
    throw new Error("not used in discovery tests");
  }
}

function makeServer(
  exposure: MCPServerCustomResource["spec"]["exposure"],
  identityProviders?: string[],
): MCPServerCustomResource {
  return {
    apiVersion: "core.controller-agent.dev/v1alpha1",
    kind: "MCPServer",
    metadata: { name: "github-mcp", uid: "srv-uid", generation: 3 },
    spec: {
      transport: "streamable-http",
      url: "https://mcp.example/",
      identityProviders,
      exposure,
    },
  };
}

function discoveryWith(k8s: FakeK8s, client: McpClient): Discovery {
  return new Discovery({
    client,
    toolWriter: new MCPToolWriter({ api: k8s, namespace: "ns", group: "g", version: "v" }),
    statusWriter: new MCPServerStatusWriter({ api: k8s, namespace: "ns", group: "g", version: "v" }),
  });
}

function binding(cr: MCPServerCustomResource, serviceToken?: string): MCPServerBinding {
  return { name: cr.metadata.name, cr, serviceToken };
}

describe("discovery", () => {
  let k8s: FakeK8s;
  beforeEach(() => {
    k8s = new FakeK8s();
  });

  const liveTools: DiscoveredTool[] = [
    {
      name: "search_issues",
      description: "Search issues",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    { name: "get_pull_request", description: "Get a PR" },
  ];

  it("materializes an exposed tool that the server advertises", async () => {
    const server = makeServer(
      [{ remoteToolName: "search_issues", allowedRoles: ["eng", "support"], tier: "standard" }],
      ["github"],
    );
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));

    const tool = k8s.tools.get(SEARCH_ISSUES_ID);
    expect(tool).toBeDefined();
    // description/inputSchema from the LIVE tool; roles/tier from the EXPOSURE
    // entry; identityProviders from the SERVER.
    expect(tool!.spec).toMatchObject({
      serverRef: "github-mcp",
      remoteToolName: "search_issues",
      description: "Search issues",
      allowedRoles: ["eng", "support"],
      tier: "standard",
      identityProviders: ["github"],
    });
    expect(JSON.parse(tool!.spec.inputSchema!)).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    // Owned by its server (cascade delete) and labeled for listing.
    expect(tool!.metadata.labels?.[SERVER_LABEL]).toBe("github-mcp");
    expect(tool!.metadata.ownerReferences?.[0]).toMatchObject({
      kind: "MCPServer",
      name: "github-mcp",
      uid: "srv-uid",
      controller: true,
    });
  });

  it("copies approval from the exposure entry onto the materialized MCPTool (ADR 0003)", async () => {
    const server = makeServer(
      [{ remoteToolName: "search_issues", allowedRoles: ["eng"], approval: "always" }],
      ["github"],
    );
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));

    expect(k8s.tools.get(SEARCH_ISSUES_ID)!.spec).toMatchObject({ approval: "always" });
  });

  it("omits approval when the exposure entry sets none (existing servers unaffected)", async () => {
    const server = makeServer([{ remoteToolName: "search_issues", allowedRoles: ["eng"] }], ["github"]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));

    expect(k8s.tools.get(SEARCH_ISSUES_ID)!.spec.approval).toBeUndefined();
  });

  it("does not materialize an expose:false entry, but records the role assignment on status", async () => {
    const server = makeServer([
      { remoteToolName: "search_issues", allowedRoles: ["eng"], expose: false },
    ]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));

    expect(k8s.tools.size).toBe(0);
    const status = k8s.status.get("github-mcp")!;
    expect(status.exposedTools).toBe(0);
    const discovered = status.discoveredTools as Array<{ name: string; exposed?: boolean }>;
    // The tool is still surfaced on status, marked not-exposed.
    expect(discovered.find((t) => t.name === "search_issues")?.exposed).toBe(false);
  });

  it("does not materialize an exposure entry the server does not advertise", async () => {
    const server = makeServer([{ remoteToolName: "no_such_tool", allowedRoles: ["eng"] }]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));
    expect(k8s.tools.size).toBe(0);
    expect(k8s.status.get("github-mcp")!.exposedTools).toBe(0);
  });

  it("writes the full inventory with exposed flags and the exposed count", async () => {
    const server = makeServer([{ remoteToolName: "search_issues", allowedRoles: ["eng"] }]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));

    const status = k8s.status.get("github-mcp")!;
    const discovered = status.discoveredTools as Array<{ name: string; exposed?: boolean }>;
    expect(discovered.map((t) => t.name)).toEqual(["search_issues", "get_pull_request"]);
    expect(discovered.find((t) => t.name === "search_issues")?.exposed).toBe(true);
    expect(discovered.find((t) => t.name === "get_pull_request")?.exposed).toBe(false);
    expect(status.exposedTools).toBe(1);
    expect(status.observedGeneration).toBe(3);
    const conditions = status.conditions as Array<{ type: string; status: string }>;
    expect(conditions[0]).toMatchObject({ type: "Ready", status: "True" });
  });

  it("deletes an owned tool the server no longer advertises (existence rule §6)", async () => {
    const server = makeServer([
      { remoteToolName: "search_issues", allowedRoles: ["eng"] },
      { remoteToolName: "get_pull_request", allowedRoles: ["eng"] },
    ]);
    // First pass: both tools live and exposed.
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));
    expect(k8s.tools.size).toBe(2);

    // Second pass: the server dropped get_pull_request from tools/list.
    await discoveryWith(k8s, new FakeMcpClient([liveTools[0]!])).runServer(binding(server, "svc"));
    expect([...k8s.tools.keys()]).toEqual([SEARCH_ISSUES_ID]);
  });

  it("deletes an owned tool whose exposure entry was withdrawn", async () => {
    const exposed = makeServer([{ remoteToolName: "search_issues", allowedRoles: ["eng"] }]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(exposed, "svc"));
    expect(k8s.tools.size).toBe(1);

    // Operator sets expose:false — the tool still lives on the server, but
    // permission was withdrawn, so the derived record must go.
    const withdrawn = makeServer([
      { remoteToolName: "search_issues", allowedRoles: ["eng"], expose: false },
    ]);
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(withdrawn, "svc"));
    expect(k8s.tools.size).toBe(0);
  });

  it("records Degraded and keeps existing tools when the server is unreachable", async () => {
    const server = makeServer([{ remoteToolName: "search_issues", allowedRoles: ["eng"] }]);
    // Seed a successful pass.
    await discoveryWith(k8s, new FakeMcpClient(liveTools)).runServer(binding(server, "svc"));
    expect(k8s.tools.size).toBe(1);

    // Now the server cannot be reached: tools must NOT be deleted (unreachable
    // is "we do not know", not "nothing exists").
    const unreachable = new FakeMcpClient((): never => {
      throw new McpTransportError("connection refused");
    });
    await discoveryWith(k8s, unreachable).runServer(binding(server, "svc"));

    expect(k8s.tools.size).toBe(1);
    const conditions = k8s.status.get("github-mcp")!.conditions as Array<{
      type: string;
      status: string;
      message: string;
    }>;
    expect(conditions[0]).toMatchObject({ type: "Ready", status: "False" });
    expect(conditions[0]!.message).toContain("connection refused");
  });

  it("runAll continues past a failing server", async () => {
    const good = makeServer([{ remoteToolName: "search_issues", allowedRoles: ["eng"] }]);
    const bad: MCPServerCustomResource = {
      apiVersion: "core.controller-agent.dev/v1alpha1",
      kind: "MCPServer",
      metadata: { name: "bad-mcp", uid: "bad-uid", generation: 1 },
      spec: {
        transport: "streamable-http",
        url: "https://bad.example/",
        exposure: [{ remoteToolName: "search_issues", allowedRoles: ["eng"] }],
      },
    };
    // Throws only for the bad server's url; the good one still materializes.
    const client: McpClient = {
      async listTools({ url }) {
        if (url === "https://bad.example/") throw new McpTransportError("down");
        return liveTools;
      },
      async callTool() {
        throw new Error("unused");
      },
    };
    await discoveryWith(k8s, client).runAll([binding(good, "svc"), binding(bad, "svc")]);

    // The good server's tool is materialized; the bad one is Degraded, not fatal.
    expect([...k8s.tools.keys()]).toEqual([SEARCH_ISSUES_ID]);
    expect((k8s.status.get("bad-mcp")!.conditions as Array<{ status: string }>)[0]!.status).toBe(
      "False",
    );
  });
});
