import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Event } from "@controller-agent/messaging";
import type { AgentRunLauncherPort } from "./k8s/agentrun-launcher.js";
import type { ToolRunLauncherPort } from "./k8s/toolrun-launcher.js";
import type { IdentityResolver } from "./rbac/types.js";
import type { CatalogRegistry } from "./registry/types.js";
import type { InboundEvent } from "./types.js";

export type RunStatus = "pending" | "succeeded" | "failed";

export interface RunRecord {
  id: string;
  status: RunStatus;
  result?: unknown;
  error?: string;
}

export interface JobAwaiter {
  awaitJob(jobId: string): Promise<Event>;
}

export interface GatewayServerOptions {
  registry: CatalogRegistry;
  identityResolver: IdentityResolver;
  toolRunLauncher: ToolRunLauncherPort;
  agentRunLauncher: AgentRunLauncherPort;
  jobAwaiter: JobAwaiter;
  callbackBaseUrl: string;
  runTimeoutSeconds: number;
}

/**
 * Consumer-facing HTTP interface for the direct integrations gateway proposal.
 * Phase 1 intentionally mirrors the orchestrator's async accept/poll shape,
 * but names the catalog entry directly (`/fn/:id`) instead of going through RAG.
 */
export class GatewayServer {
  private server: Server | undefined;
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly options: GatewayServerOptions) {}

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.error(error);
          if (!res.writableEnded) res.writeHead(500).end();
        });
      });
      this.server.listen(port, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    const invokeMatch = /^\/fn\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && invokeMatch) {
      await this.handleInvoke(req, res, invokeMatch[1] as string);
      return;
    }

    const runMatch = /^\/fn\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      this.handleGetRun(res, runMatch[1] as string);
      return;
    }

    res.writeHead(404).end();
  }

  private async handleInvoke(req: IncomingMessage, res: ServerResponse, targetId: string): Promise<void> {
    const rawBody = await readBody(req);

    let input: string;
    let args: string[] | undefined;
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { input?: unknown }).input !== "string" ||
        (parsed as { input: string }).input.trim() === ""
      ) {
        throw new Error("invalid body");
      }
      input = (parsed as { input: string }).input;
      const rawArgs = (parsed as { args?: unknown }).args;
      if (rawArgs !== undefined) {
        if (!Array.isArray(rawArgs) || !rawArgs.every((value) => typeof value === "string")) {
          throw new Error("invalid args");
        }
        args = [...rawArgs];
      }
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ error: 'body must be JSON: { "input": "<non-empty string>", "args"?: ["..."] }' }),
      );
      return;
    }

    const identity = await this.options.identityResolver.resolve(bearerToken(req.headers.authorization));
    if (!identity) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "unauthorized: could not resolve caller identity" }),
      );
      return;
    }

    const entry = await this.options.registry.getById(targetId);
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `unknown function: ${targetId}` }));
      return;
    }

    if (entry.allowedRoles.length > 0 && !entry.allowedRoles.some((role) => identity.roles.includes(role))) {
      res.writeHead(403, { "content-type": "application/json" }).end(
        JSON.stringify({ error: `forbidden: caller lacks an allowed role for ${targetId}` }),
      );
      return;
    }

    const id = randomUUID();
    this.runs.set(id, { id, status: "pending" });

    const event: InboundEvent = {
      channel: "faas",
      callerIdentity: identity,
      text: input,
      target: { kind: entry.kind, id: targetId, ...(args ? { args } : {}) },
    };

    void this.launchAndAwait(id, entry, event).catch((error: unknown) => {
      this.runs.set(id, {
        id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });

    res.writeHead(202, { "content-type": "application/json", location: `/fn/runs/${id}` }).end(
      JSON.stringify({ id, status: "pending" }),
    );
  }

  private handleGetRun(res: ServerResponse, id: string): void {
    const run = this.runs.get(id);
    if (!run) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `unknown run: ${id}` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(run));
  }

  private async launchAndAwait(id: string, entry: Awaited<ReturnType<CatalogRegistry["getById"]>> extends infer R ? Exclude<R, undefined> : never, event: InboundEvent): Promise<void> {
    const callbackUrl = `${this.options.callbackBaseUrl.replace(/\/$/, "")}/callback/${id}`;
    if (entry.kind === "tool" && entry.jobTemplate) {
      await this.options.toolRunLauncher.launch(entry.jobTemplate, {
        args: [event.text, ...(event.target?.args ?? [])],
        callbackUrl,
      });
    } else if (entry.agentRunTemplate) {
      await this.options.agentRunLauncher.launch(entry.agentRunTemplate, id, {
        goal: event.text,
        callbackUrl,
        timeoutSeconds: this.options.runTimeoutSeconds,
      });
    } else {
      throw new Error(`catalog entry ${entry.id} is missing a launch template`);
    }

    const terminal = await this.options.jobAwaiter.awaitJob(id);
    this.runs.set(id, terminalEventToRecord(id, terminal));
  }
}

function terminalEventToRecord(id: string, event: Event): RunRecord {
  if (event.type === "succeeded") {
    return { id, status: "succeeded", result: event.result };
  }
  if (event.type === "failed") {
    return { id, status: "failed", error: event.message };
  }
  return { id, status: "failed", error: `unexpected non-terminal event: ${event.type}` };
}

function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
