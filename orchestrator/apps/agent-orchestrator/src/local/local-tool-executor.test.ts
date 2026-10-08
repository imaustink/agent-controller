import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../tool-descriptor.js";
import {
  LocalToolExecutor,
  type LocalToolRunRequest,
  type SecretReader,
} from "./local-tool-executor.js";

/** Records the last request body and replies with a canned envelope/status. */
interface FakeSidecar {
  server: Server;
  socketDir: string;
  lastRequest?: LocalToolRunRequest;
}

async function startSidecar(
  runtime: string,
  handler: (req: LocalToolRunRequest) => { status?: number; body: string } | "hang",
): Promise<FakeSidecar> {
  const socketDir = await mkdtemp(join(tmpdir(), "localtool-sock-"));
  const state: FakeSidecar = { server: undefined as unknown as Server, socketDir };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.lastRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LocalToolRunRequest;
      const result = handler(state.lastRequest);
      if (result === "hang") return; // never respond
      res.statusCode = result.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(socketDir, `${runtime}.sock`), resolve));
  state.server = server;
  return state;
}

const staticReader: SecretReader = { read: async () => undefined };

function descriptor(overrides: Partial<ToolDescriptor["localExec"]> = {}): ToolDescriptor {
  return {
    id: "http-get-node",
    name: "http-get-node",
    description: "fetch",
    allowedRoles: ["reader"],
    localExec: { runtime: "node", package: "p", version: "1.0.0", network: false, ...overrides },
  };
}

describe("LocalToolExecutor", () => {
  let sidecar: FakeSidecar | undefined;

  afterEach(async () => {
    if (sidecar) {
      await new Promise<void>((resolve) => sidecar!.server.close(() => resolve()));
      await rm(sidecar.socketDir, { recursive: true, force: true });
      sidecar = undefined;
    }
  });

  it("posts a run request and maps a succeeded envelope to a succeeded Event", async () => {
    sidecar = await startSidecar("node", () => ({
      body: JSON.stringify({ type: "succeeded", result: { status: 200 } }),
    }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    const event = await executor.run(descriptor({ env: { FOO: "bar" } }), "https://example.com");

    expect(event.type).toBe("succeeded");
    if (event.type === "succeeded") expect(event.result).toEqual({ status: 200 });
    expect(sidecar.lastRequest).toMatchObject({
      runtime: "node",
      package: "p",
      version: "1.0.0",
      input: "https://example.com",
      network: false,
      env: { FOO: "bar" },
    });
  });

  it("sets SESSION_ID in the tool's env when a sessionId is given (docs/adr/0012)", async () => {
    sidecar = await startSidecar("node", () => ({ body: JSON.stringify({ type: "succeeded", result: "ok" }) }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    await executor.run(descriptor({ env: { FOO: "bar" } }), "https://example.com", "chat-42");

    expect(sidecar.lastRequest).toMatchObject({ env: { FOO: "bar", SESSION_ID: "chat-42" } });
  });

  it("omits SESSION_ID from the tool's env when no sessionId is given", async () => {
    sidecar = await startSidecar("node", () => ({ body: JSON.stringify({ type: "succeeded", result: "ok" }) }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    await executor.run(descriptor({ env: { FOO: "bar" } }), "https://example.com");

    expect(sidecar.lastRequest?.env).toEqual({ FOO: "bar" });
  });

  it("resolves secretEnv and passes ONLY declared env (never the orchestrator's own secrets)", async () => {
    // The orchestrator's real OPENAI_API_KEY is in this process's env...
    process.env.OPENAI_API_KEY = "sk-orchestrator-secret";
    sidecar = await startSidecar("node", () => ({ body: JSON.stringify({ type: "succeeded", result: "ok" }) }));
    const reader: SecretReader = {
      read: async (name, key) => (name === "s" && key === "k" ? "resolved-token" : undefined),
    };
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: reader,
    });

    await executor.run(
      descriptor({ env: { FOO: "bar" }, secretEnv: [{ name: "TOKEN", secretRef: { name: "s", key: "k" } }] }),
      "in",
    );

    expect(sidecar.lastRequest?.env).toEqual({ FOO: "bar", TOKEN: "resolved-token" });
    // ...but it must NOT leak into the tool's env.
    expect(sidecar.lastRequest?.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("fails closed when a referenced secret is missing", async () => {
    sidecar = await startSidecar("node", () => ({ body: JSON.stringify({ type: "succeeded", result: "ok" }) }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    const event = await executor.run(
      descriptor({ secretEnv: [{ name: "TOKEN", secretRef: { name: "missing", key: "k" } }] }),
      "in",
    );

    expect(event.type).toBe("failed");
    if (event.type === "failed") expect(event.code).toBe("secret_missing");
    expect(sidecar.lastRequest).toBeUndefined(); // never reached the sidecar
  });

  it("maps a failed envelope to a failed Event", async () => {
    sidecar = await startSidecar("node", () => ({
      body: JSON.stringify({ type: "failed", code: "http_error", message: "boom" }),
    }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    const event = await executor.run(descriptor(), "in");
    expect(event.type).toBe("failed");
    if (event.type === "failed") {
      expect(event.code).toBe("http_error");
      expect(event.message).toBe("boom");
    }
  });

  it("maps a non-2xx sidecar response to an executor_error Event", async () => {
    sidecar = await startSidecar("node", () => ({ status: 500, body: "internal error" }));
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 30,
      secretReader: staticReader,
    });

    const event = await executor.run(descriptor(), "in");
    expect(event.type).toBe("failed");
    if (event.type === "failed") expect(event.code).toBe("executor_error");
  });

  it("times out (backstop) when the sidecar never responds", async () => {
    sidecar = await startSidecar("node", () => "hang");
    const executor = new LocalToolExecutor({
      socketDir: sidecar.socketDir,
      defaultTimeoutSeconds: 0.1,
      backstopBufferSeconds: 0,
      secretReader: staticReader,
    });

    const event = await executor.run(descriptor(), "in");
    expect(event.type).toBe("failed");
    if (event.type === "failed") expect(event.code).toBe("executor_error");
  });
});
