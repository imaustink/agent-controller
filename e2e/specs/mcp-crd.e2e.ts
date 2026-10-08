import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import {
  kubectl,
  kubectlJson,
  kubectlApplyStdin,
  waitFor,
  withPortForward,
  fetchThrough,
} from "../support/k8s.js";

/**
 * MCP support against the REAL deployed stack (ADR 0045): the mcp-broker
 * discovering a real in-cluster MCP server, materializing MCPTool CRs, and
 * proxying a real tools/call under a per-user token.
 *
 * The contract between the engine client, the broker and the Go activity is
 * covered hermetically by `mcp-broker-contract.e2e.ts`. This covers the hops
 * that one cannot see, each of which has a scalp in this repo's history:
 *
 *   - whether the chart's hand-copied Role grants each process the mcptools it
 *     watches. core-controller's ClusterRole shipped missing a kind twice, the
 *     broker's Role once, the orchestrator's once — every one crashloops rather
 *     than degrading, several screens into a log about something else.
 *   - whether the broker's REAL informer picks up an MCPServer and writes the
 *     derived MCPTools a fake k8s client cannot prove it would.
 *   - whether the delegated token actually survives the whole path — engine →
 *     broker → the upstream server — and arrives as the CALLER, which the fake
 *     server's `whoami` reflects back so the test can see it.
 *
 * The only stub is the MCP server itself (orchestrator/apps/fake-mcp-server), deployed by the
 * community-components e2e overlay. Everything else runs for real. Objects are
 * namespaced and deleted in afterAll.
 */

requireMinikubeContext();

const SERVER = "e2e-fake-mcp";
const BROKER_SERVICE = "agent-controller-mcp-broker";
// Must equal e2e/scripts/bootstrap-secrets.sh's MCP_BROKER_TOKEN.
const BROKER_TOKEN = "e2e-mcp-broker-token";
const FAKE_URL = "http://fake-mcp-server.controller-agent.svc.cluster.local:8080/mcp";

// catalogIdFor sanitizes `mcp-<server>-<remoteTool>` to a legal k8s name.
const toolName = (remote: string) => `mcp-${SERVER}-${remote}`;

const serverManifest = (exposure: string) => `
apiVersion: core.controller-agent.dev/v1alpha1
kind: MCPServer
metadata:
  name: ${SERVER}
  labels: { e2e: "true" }
spec:
  transport: streamable-http
  url: ${FAKE_URL}
  displayName: "Fake MCP"
  # Declaring an identity provider makes invocation run AS THE USER: the broker
  # requires a delegated token and never falls back to a shared credential.
  identityProviders:
    - github
  exposure:
${exposure}
`;

const expose = (remote: string, extra = "") =>
  `    - remoteToolName: ${remote}\n      allowedRoles: [engineering]\n${extra}`;

interface MCPServerStatus {
  status?: {
    exposedTools?: number;
    discoveredTools?: { name: string; exposed?: boolean }[];
    conditions?: { type: string; status: string }[];
  };
}

interface MCPToolCR {
  metadata: { name: string; labels?: Record<string, string>; ownerReferences?: { kind: string; name: string }[] };
  spec: { serverRef: string; remoteToolName: string; allowedRoles: string[]; identityProviders?: string[] };
}

async function deleteIfPresent(kind: string, name: string) {
  await kubectl(["delete", kind, name, "--ignore-not-found", "--wait=false"]).catch(() => "");
}

beforeAll(async () => {
  await deleteIfPresent("mcpserver", SERVER);
});

afterAll(async () => {
  // Deleting the server cascades its MCPTools via their ownerReferences.
  await deleteIfPresent("mcpserver", SERVER);
});

describe("the CRDs this branch generates are the ones installed", () => {
  it("has the mcpservers and mcptools CRDs", async () => {
    const names = await kubectl(["get", "crd", "-o", "name"]);
    expect(names).toContain("mcpservers.core.controller-agent.dev");
    expect(names).toContain("mcptools.core.controller-agent.dev");
  });

  it("serves the MCPServer.spec fields the broker reads", async () => {
    const props = await kubectl([
      "get",
      "crd",
      "mcpservers.core.controller-agent.dev",
      "-o",
      "jsonpath={.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}",
    ]);
    for (const field of ["transport", "url", "exposure", "identityProviders", "secretEnv"]) {
      expect(props, `MCPServer.spec is missing ${field}`).toContain(field);
    }
  });
});

/**
 * The namespaced Role bound to a Deployment's ServiceAccount, found by a label
 * selector rather than named — the chart's fullname depends on the release name,
 * so a hardcoded Role name reads a different install as "RBAC is broken".
 */
async function roleForSelector(selector: string): Promise<{
  rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
}> {
  const serviceAccount = (
    await kubectl(["get", "deploy", "-l", selector, "-o", "jsonpath={.items[0].spec.template.spec.serviceAccountName}"])
  ).trim();
  expect(serviceAccount, `no Deployment matched ${selector}`).not.toBe("");

  const bindings = await kubectlJson<{
    items: { roleRef: { name: string }; subjects?: { kind: string; name: string }[] }[];
  }>(["get", "rolebinding", "-o", "json"]);
  const binding = bindings.items.find((b) =>
    (b.subjects ?? []).some((s) => s.kind === "ServiceAccount" && s.name === serviceAccount),
  );
  expect(binding, `nothing binds a Role to ${serviceAccount}`).toBeDefined();

  return kubectlJson(["get", "role", binding!.roleRef.name, "-o", "json"]);
}

const grantedKinds = (role: { rules: { apiGroups: string[]; resources: string[] }[] }) =>
  new Set(
    role.rules
      .filter((rule) => rule.apiGroups.includes("core.controller-agent.dev"))
      .flatMap((rule) => rule.resources),
  );

describe("the chart grants every process the mcptools it watches", () => {
  it("lets the mcp-broker read MCPServers and own MCPTools", async () => {
    // The broker's watch 403s at startup and crashloops without these; the owned
    // kind is what it must create, patch and delete (the existence rule §6).
    const granted = grantedKinds(await roleForSelector("app.kubernetes.io/name=mcp-broker"));
    for (const kind of ["mcpservers", "mcpservers/status", "mcptools", "mcptools/status"]) {
      expect([...granted], `the mcp-broker Role is missing ${kind}`).toContain(kind);
    }
  });

  it("lets the mcp-broker read the discovery Secrets a server names", async () => {
    const role = await roleForSelector("app.kubernetes.io/name=mcp-broker");
    const secretVerbs = role.rules
      .filter((r) => r.apiGroups.includes("") && r.resources.includes("secrets"))
      .flatMap((r) => r.verbs);
    expect(secretVerbs).toContain("get");
  });

  it("lets catalog-sync read MCPTools, so the planner can see them", async () => {
    // Without this the mcptools informer's initial LIST 403s and catalog-sync
    // crashloops; with it missing-but-quiet, every MCP tool is simply absent.
    const granted = grantedKinds(await roleForSelector("app.kubernetes.io/component=catalog-sync"));
    expect([...granted]).toContain("mcptools");
  });

  it("lets the orchestrator read MCPTools", async () => {
    const granted = grantedKinds(await roleForSelector("app.kubernetes.io/name=agent-orchestrator"));
    expect([...granted]).toContain("mcptools");
  });
});

describe("the broker discovers the fake server and materializes its tools", () => {
  beforeAll(async () => {
    await kubectlApplyStdin(serverManifest(`${expose("echo")}${expose("whoami")}`));
  });

  it("reports the server's full inventory on status, marking the exposed ones", async () => {
    const status = await waitFor(
      "the MCPServer status carries the discovered tools",
      async () => {
        const server = await kubectlJson<MCPServerStatus>(["get", "mcpserver", SERVER, "-o", "json"]);
        return server.status?.discoveredTools?.length ? server.status : undefined;
      },
      { timeoutMs: 90_000 },
    );

    const byName = new Map((status.discoveredTools ?? []).map((t) => [t.name, t.exposed]));
    // The fake server advertises all three; the status reports all three.
    for (const t of ["echo", "whoami", "boom"]) {
      expect([...byName.keys()], `status is missing ${t}`).toContain(t);
    }
    // Exposed per the operator's map: echo/whoami yes, boom no.
    expect(byName.get("echo")).toBe(true);
    expect(byName.get("whoami")).toBe(true);
    expect(byName.get("boom")).toBe(false);
    expect(status.exposedTools).toBe(2);
    expect(status.conditions?.find((c) => c.type === "Ready")?.status).toBe("True");
  });

  it("materializes an MCPTool for each exposed tool, owned by the server", async () => {
    const tool = await waitFor(
      "the echo MCPTool is materialized",
      async () => {
        const got = await kubectlJson<MCPToolCR | { metadata?: undefined }>([
          "get",
          "mcptool",
          toolName("echo"),
          "-o",
          "json",
        ]).catch(() => ({}) as { metadata?: undefined });
        return got.metadata ? (got as MCPToolCR) : undefined;
      },
      { timeoutMs: 90_000 },
    );

    expect(tool.spec.serverRef).toBe(SERVER);
    expect(tool.spec.remoteToolName).toBe("echo");
    expect(tool.spec.allowedRoles).toEqual(["engineering"]);
    expect(tool.spec.identityProviders).toEqual(["github"]);
    // Owned by its MCPServer, so deleting the server cascades the tool.
    expect(tool.metadata.ownerReferences?.some((o) => o.kind === "MCPServer" && o.name === SERVER)).toBe(true);

    // boom was advertised but never exposed → no MCPTool.
    const boom = await kubectl(["get", "mcptool", toolName("boom"), "--ignore-not-found", "-o", "name"]);
    expect(boom.trim()).toBe("");
  });

  it("deletes a tool's MCPTool when the operator withdraws its exposure (§6)", async () => {
    // Re-apply the server exposing only echo. whoami's derived tool must leave
    // the catalog rather than linger as a tombstone that fails when invoked.
    await kubectlApplyStdin(serverManifest(expose("echo")));

    await waitFor(
      "the whoami MCPTool is removed",
      async () => {
        const got = await kubectl(["get", "mcptool", toolName("whoami"), "--ignore-not-found", "-o", "name"]);
        return got.trim() === "" ? true : undefined;
      },
      { timeoutMs: 90_000 },
    );

    // The still-exposed tool stays.
    const echo = await kubectl(["get", "mcptool", toolName("echo"), "--ignore-not-found", "-o", "name"]);
    expect(echo.trim()).not.toBe("");

    // Restore both for the invocation block below.
    await kubectlApplyStdin(serverManifest(`${expose("echo")}${expose("whoami")}`));
    await waitFor(
      "whoami is materialized again",
      async () => {
        const got = await kubectl(["get", "mcptool", toolName("whoami"), "--ignore-not-found", "-o", "name"]);
        return got.trim() !== "" ? true : undefined;
      },
      { timeoutMs: 90_000 },
    );
  });
});

describe("the broker proxies a real call as the caller", () => {
  const callPath = (tool: string) => `/servers/${SERVER}/tools/${tool}/call`;

  it("forwards the caller's delegated token all the way to the server", async () => {
    // whoami reflects the Bearer it received. A shared-credential fallback would
    // reflect something else; the delegated token arriving is the whole point of
    // ADR 0045 §5, end to end.
    const DELEGATED = "alice-e2e-delegated-token";
    const result = await withPortForward(BROKER_SERVICE, 8080, 18085, async (_url, forward) => {
      const res = await fetchThrough(forward, callPath("whoami"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BROKER_TOKEN}`,
          "x-delegated-token": DELEGATED,
        },
        body: JSON.stringify({ arguments: {} }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { result: string; isError: boolean };
    });

    expect(result.isError).toBe(false);
    expect(result.result, "the delegated token must arrive at the server as the caller").toContain(DELEGATED);
  });

  it("echoes arguments through the real MCP round trip", async () => {
    const result = await withPortForward(BROKER_SERVICE, 8080, 18086, async (_url, forward) => {
      const res = await fetchThrough(forward, callPath("echo"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BROKER_TOKEN}`,
          "x-delegated-token": "t",
        },
        body: JSON.stringify({ arguments: { text: "e2e-hello" } }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { result: string };
    });
    expect(result.result).toContain("e2e-hello");
  });

  it("fails closed when the caller presents no delegated token", async () => {
    // The server declares identityProviders, so a call with no x-delegated-token
    // is refused 403 — never run on the discovery credential.
    const status = await withPortForward(BROKER_SERVICE, 8080, 18087, async (_url, forward) => {
      const res = await fetchThrough(forward, callPath("whoami"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BROKER_TOKEN}` },
        body: JSON.stringify({ arguments: {} }),
      });
      return res.status;
    });
    expect(status).toBe(403);
  });

  it("rejects a bad broker token with 401", async () => {
    const status = await withPortForward(BROKER_SERVICE, 8080, 18088, async (_url, forward) => {
      const res = await fetchThrough(forward, callPath("whoami"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-the-token",
          "x-delegated-token": "t",
        },
        body: JSON.stringify({ arguments: {} }),
      });
      return res.status;
    });
    expect(status).toBe(401);
  });

  it("refuses an unexposed tool with 404", async () => {
    // boom is advertised by the server but never exposed; the broker refuses to
    // proxy it even though it exists (the operator is truth for permission, §6).
    const status = await withPortForward(BROKER_SERVICE, 8080, 18089, async (_url, forward) => {
      const res = await fetchThrough(forward, callPath("boom"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BROKER_TOKEN}`,
          "x-delegated-token": "t",
        },
        body: JSON.stringify({ arguments: {} }),
      });
      return res.status;
    });
    expect(status).toBe(404);
  });
});
