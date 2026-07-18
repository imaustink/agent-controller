import { describe, expect, it, vi } from "vitest";
import type { Event } from "@controller-agent/messaging";
import { GatewayServer } from "./server.js";
import type { AgentRunLauncherPort } from "./k8s/agentrun-launcher.js";
import type { ToolRunLauncherPort } from "./k8s/toolrun-launcher.js";
import type { IdentityResolver } from "./rbac/types.js";
import type { CatalogEntry, CatalogRegistry } from "./registry/types.js";

function listenOn(server: GatewayServer): Promise<number> {
  return server.listen(0).then(() => {
    const address = server["server"]?.address();
    return typeof address === "object" && address ? address.port : 0;
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeServer(options?: {
  registry?: CatalogRegistry;
  identityResolver?: IdentityResolver;
  toolRunLauncher?: ToolRunLauncherPort;
  agentRunLauncher?: AgentRunLauncherPort;
  awaitJob?: (id: string) => Promise<Event>;
}) {
  const registry: CatalogRegistry =
    options?.registry ??
    ({
      getById: vi.fn().mockResolvedValue({
        kind: "tool",
        id: "recipe-scraper",
        allowedRoles: ["reader"],
        jobTemplate: { image: "example.com/tool", namespace: "default", serviceAccountName: "tool", toolRef: "recipe-scraper" },
      } satisfies CatalogEntry),
    } satisfies CatalogRegistry);
  const identityResolver: IdentityResolver =
    options?.identityResolver ??
    ({ resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["reader"] }) } satisfies IdentityResolver);
  const toolRunLauncher: ToolRunLauncherPort =
    options?.toolRunLauncher ??
    ({ launch: vi.fn().mockResolvedValue({ name: "toolrun-1", namespace: "default" }) } satisfies ToolRunLauncherPort);
  const agentRunLauncher: AgentRunLauncherPort =
    options?.agentRunLauncher ??
    ({ launch: vi.fn().mockResolvedValue({ name: "agentrun-1", namespace: "default" }) } satisfies AgentRunLauncherPort);
  const server = new GatewayServer({
    registry,
    identityResolver,
    toolRunLauncher,
    agentRunLauncher,
    jobAwaiter: { awaitJob: options?.awaitJob ?? vi.fn().mockResolvedValue({ type: "succeeded", job_id: "x", seq: 1, ts: new Date().toISOString(), result: { ok: true } } satisfies Event) },
    callbackBaseUrl: "http://gateway-callback.default.svc.cluster.local:8091",
    runTimeoutSeconds: 600,
  });
  return { server, registry, identityResolver, toolRunLauncher, agentRunLauncher };
}

describe("GatewayServer", () => {
  it("rejects an invalid body with 400 without launching anything", async () => {
    const { server, registry, toolRunLauncher } = makeServer();
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/fn/recipe-scraper`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "******" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect((registry.getById as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((toolRunLauncher.launch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    await server.close();
  });

  it("returns 401 when the bearer token is missing or invalid", async () => {
    const identityResolver: IdentityResolver = { resolve: vi.fn().mockResolvedValue(undefined) };
    const { server, registry } = makeServer({ identityResolver });
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/fn/recipe-scraper`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "https://example.com/recipe" }),
    });

    expect(res.status).toBe(401);
    expect((registry.getById as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    await server.close();
  });

  it("returns 404 when the catalog entry does not exist", async () => {
    const registry: CatalogRegistry = { getById: vi.fn().mockResolvedValue(undefined) };
    const { server } = makeServer({ registry });
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/fn/missing`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "******" },
      body: JSON.stringify({ input: "do something" }),
    });

    expect(res.status).toBe(404);
    await server.close();
  });

  it("returns 403 when the caller's roles do not intersect allowedRoles", async () => {
    const registry: CatalogRegistry = {
      getById: vi.fn().mockResolvedValue({
        kind: "tool",
        id: "writer-tool",
        allowedRoles: ["writer"],
        jobTemplate: { image: "example.com/tool", namespace: "default", serviceAccountName: "tool", toolRef: "writer-tool" },
      } satisfies CatalogEntry),
    };
    const { server, toolRunLauncher } = makeServer({ registry });
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/fn/writer-tool`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "******" },
      body: JSON.stringify({ input: "do something" }),
    });

    expect(res.status).toBe(403);
    expect((toolRunLauncher.launch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    await server.close();
  });

  it("returns 202, then poll transitions from pending to succeeded once the callback promise resolves", async () => {
    const terminal = deferred<Event>();
    const { server, toolRunLauncher } = makeServer({ awaitJob: vi.fn().mockReturnValue(terminal.promise) });
    const port = await listenOn(server);

    const postRes = await fetch(`http://127.0.0.1:${port}/fn/recipe-scraper`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "******" },
      body: JSON.stringify({ input: "https://example.com/recipe", args: ["--format=json"] }),
    });

    expect(postRes.status).toBe(202);
    expect(postRes.headers.get("location")).toMatch(/^\/fn\/runs\//);
    const { id, status } = (await postRes.json()) as { id: string; status: string };
    expect(status).toBe("pending");
    expect(toolRunLauncher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ toolRef: "recipe-scraper" }),
      expect.objectContaining({
        args: ["https://example.com/recipe", "--format=json"],
        callbackUrl: `http://gateway-callback.default.svc.cluster.local:8091/callback/${id}`,
      }),
    );

    const pendingRes = await fetch(`http://127.0.0.1:${port}/fn/runs/${id}`);
    expect(pendingRes.status).toBe(200);
    expect((await pendingRes.json()) as { status: string }).toMatchObject({ status: "pending" });

    terminal.resolve({ type: "succeeded", job_id: "tool-job", seq: 1, ts: new Date().toISOString(), result: { title: "Pancakes" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const doneRes = await fetch(`http://127.0.0.1:${port}/fn/runs/${id}`);
    expect((await doneRes.json()) as { status: string; result: unknown }).toMatchObject({
      status: "succeeded",
      result: { title: "Pancakes" },
    });

    await server.close();
  });

  it("returns 404 for an unknown run id", async () => {
    const { server } = makeServer();
    const port = await listenOn(server);

    const res = await fetch(`http://127.0.0.1:${port}/fn/runs/does-not-exist`);
    expect(res.status).toBe(404);

    await server.close();
  });
});
