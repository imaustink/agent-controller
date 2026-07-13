import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import type { Event } from "@recipe-agent/messaging";
import type { LocalToolSpec, ToolDescriptor } from "../tool-descriptor.js";

/**
 * The request the orchestrator sends to a per-language executor sidecar over
 * the pod-local unix socket (ADR 0014). Mirrors what the Go executor's
 * `POST /run` handler accepts. Secret values are already RESOLVED here (the
 * orchestrator holds the k8s identity; the sidecar has none) and travel only
 * over the emptyDir unix socket, never the network.
 */
export interface LocalToolRunRequest {
  runtime: LocalToolSpec["runtime"];
  package?: string;
  version?: string;
  entry?: string;
  sourceUrl?: string;
  checksum?: string;
  env: Record<string, string>;
  input: string;
  network: boolean;
  timeoutSeconds: number;
  resources?: LocalToolSpec["resources"];
}

/** The stdio-ABI envelope the sidecar relays back (a tool's final stdout line). */
export type LocalToolEnvelope =
  | { type: "succeeded"; result: unknown }
  | { type: "failed"; code: string; message: string };

/** Reads a Secret key's plaintext value; abstracted so tests can fake it. */
export interface SecretReader {
  read(secretName: string, key: string): Promise<string | undefined>;
}

interface CoreV1ApiLike {
  readNamespacedSecret(request: { name: string; namespace: string }): Promise<{ data?: Record<string, string> }>;
}

/** Default {@link SecretReader} backed by the k8s CoreV1Api (base64 `data`). */
export class K8sSecretReader implements SecretReader {
  constructor(
    private readonly namespace: string,
    private readonly api: CoreV1ApiLike,
  ) {}

  static fromKubeConfig(namespace: string, kubeConfig: k8s.KubeConfig): K8sSecretReader {
    return new K8sSecretReader(namespace, kubeConfig.makeApiClient(k8s.CoreV1Api));
  }

  async read(secretName: string, key: string): Promise<string | undefined> {
    const secret = await this.api.readNamespacedSecret({ name: secretName, namespace: this.namespace });
    const encoded = secret.data?.[key];
    if (encoded === undefined) return undefined;
    return Buffer.from(encoded, "base64").toString("utf8");
  }
}

export interface LocalToolExecutorOptions {
  /** Directory holding one `<runtime>.sock` per executor sidecar. */
  socketDir: string;
  /** Fallback per-execution timeout (seconds) when a LocalTool sets none. */
  defaultTimeoutSeconds: number;
  /** Resolves `secretEnv` references into plaintext values. */
  secretReader: SecretReader;
  /**
   * Extra seconds added to a tool's timeout before this client gives up on an
   * unresponsive sidecar (the sidecar's own SIGKILL should normally win).
   * Defaults to 5; kept configurable so tests can exercise the backstop fast.
   */
  backstopBufferSeconds?: number;
}

/**
 * Client for the per-language executor sidecars (ADR 0014). Resolves a
 * LocalTool's `secretEnv` from k8s Secrets, then POSTs a run request to the
 * matching sidecar over its unix socket and maps the returned stdio envelope
 * onto a messaging {@link Event}, so the agent graph's `runTool` node treats
 * a local run exactly like a Job callback result.
 *
 * The orchestrator never spawns a runtime itself and carries no language
 * toolchains — all fetching/sandboxing/execution happens inside the sidecar.
 */
export class LocalToolExecutor {
  constructor(private readonly opts: LocalToolExecutorOptions) {}

  async run(descriptor: ToolDescriptor, input: string): Promise<Event> {
    const jobId = randomUUID();
    const spec = descriptor.localExec;
    if (!spec) {
      return failed(jobId, "not_local", `tool ${descriptor.id} has no localExec spec`);
    }

    const env: Record<string, string> = { ...(spec.env ?? {}) };
    for (const secretEnv of spec.secretEnv ?? []) {
      let value: string | undefined;
      try {
        value = await this.opts.secretReader.read(secretEnv.secretRef.name, secretEnv.secretRef.key);
      } catch (err) {
        return failed(jobId, "secret_error", `failed to read secret ${secretEnv.secretRef.name}: ${errMsg(err)}`);
      }
      if (value === undefined) {
        return failed(
          jobId,
          "secret_missing",
          `secret ${secretEnv.secretRef.name}/${secretEnv.secretRef.key} not found`,
        );
      }
      env[secretEnv.name] = value;
    }

    const timeoutSeconds = spec.timeoutSeconds ?? this.opts.defaultTimeoutSeconds;
    const request: LocalToolRunRequest = {
      runtime: spec.runtime,
      package: spec.package,
      version: spec.version,
      entry: spec.entry,
      sourceUrl: spec.sourceUrl,
      checksum: spec.checksum,
      env,
      input,
      network: spec.network,
      timeoutSeconds,
      resources: spec.resources,
    };

    const socketPath = join(this.opts.socketDir, `${spec.runtime}.sock`);
    // Backstop timeout slightly beyond the sidecar's own, so the sidecar's
    // SIGKILL + graceful envelope normally wins the race and we only trip
    // this if the sidecar itself is unresponsive.
    const bufferSeconds = this.opts.backstopBufferSeconds ?? 5;
    const backstopMs = Math.max(1, Math.round((timeoutSeconds + bufferSeconds) * 1000));
    try {
      const envelope = await postToSidecar(socketPath, request, backstopMs);
      return toEvent(jobId, envelope);
    } catch (err) {
      return failed(jobId, "executor_error", `local tool ${descriptor.id}: ${errMsg(err)}`);
    }
  }
}

/** POST the run request to `<socketPath>/run` over a unix socket, returning the parsed envelope. */
function postToSidecar(socketPath: string, request: LocalToolRunRequest, timeoutMs: number): Promise<LocalToolEnvelope> {
  const body = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: "/run",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`sidecar returned ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as LocalToolEnvelope);
          } catch {
            reject(new Error(`sidecar returned non-JSON body: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`sidecar did not respond within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function toEvent(jobId: string, envelope: LocalToolEnvelope): Event {
  if (envelope?.type === "succeeded") {
    return { type: "succeeded", result: envelope.result, job_id: jobId, seq: 0, ts: new Date().toISOString() };
  }
  if (envelope?.type === "failed") {
    return failed(jobId, envelope.code ?? "failed", envelope.message ?? "tool failed");
  }
  return failed(jobId, "bad_envelope", "sidecar returned an unrecognized envelope");
}

function failed(jobId: string, code: string, message: string): Event {
  return { type: "failed", code, message, job_id: jobId, seq: 0, ts: new Date().toISOString() };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
