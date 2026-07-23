import { spawn, type ChildProcess } from "node:child_process";
import { clip } from "./security/redact.js";

/**
 * Drives a long-lived, loopback-only `opencode serve` process (ADR 0026)
 * instead of the old one-shot `opencode run --format json` CLI invocation.
 * `opencode serve` is a genuine headless REST+SSE server (confirmed against
 * its own `/doc` OpenAPI spec): session create, a synchronous "send message,
 * get the completed assistant reply" endpoint, and a `GET /event` SSE stream
 * of everything happening across all sessions. Binding to `127.0.0.1` keeps
 * it unreachable from outside the Pod's own network namespace -- the only
 * way in or out is this module's own HTTP calls, and (for a live viewer) the
 * NATS-forwarded `opencode_request`/`opencode_event` messages in index.ts.
 */

export interface OpencodeServerHandle {
  readonly baseUrl: string;
  /** Resolves once `/global/health` responds OK, or rejects after boundedly retrying. */
  waitForHealth(): Promise<void>;
  kill(): void;
}

/** Spawns `opencode serve`, mirroring its stdout/stderr to ours so `kubectl logs` still shows it (same reasoning as the old CLI invocation). */
export function startOpencodeServer(opts: {
  port: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): OpencodeServerHandle {
  const child: ChildProcess = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(opts.port), "--print-logs"],
    { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(clip(chunk.toString(), 2000)));

  const baseUrl = `http://127.0.0.1:${opts.port}`;

  return {
    baseUrl,
    async waitForHealth(): Promise<void> {
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${baseUrl}/global/health`);
          if (res.ok) return;
        } catch (err) {
          lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`opencode serve did not become healthy in time: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    },
    kill(): void {
      child.kill();
    },
  };
}

export interface OpencodeMessageResult {
  finalMessage: string | null;
  failed: boolean;
  failureDetail: string | null;
}

/** Creates a new opencode session. */
export async function createSession(baseUrl: string): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`opencode session create failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

/**
 * Sends a message into an opencode session and blocks until the assistant's
 * reply is complete -- `POST /session/{id}/message` is synchronous (its
 * "streaming" is internal, over `/event`; the HTTP response itself only
 * arrives once the turn is done), so this plays the same role the old code's
 * `await` on the one-shot CLI process exiting did.
 */
export async function sendMessage(baseUrl: string, sessionId: string, text: string, signal?: AbortSignal): Promise<OpencodeMessageResult> {
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    signal,
  });
  if (!res.ok) {
    return { finalMessage: null, failed: true, failureDetail: `opencode message request failed: ${res.status} ${await res.text()}` };
  }
  const body = (await res.json()) as {
    info: { error?: { message?: string; name?: string } };
    parts: Array<{ type: string; text?: string }>;
  };
  const textParts = body.parts.filter((p) => p.type === "text" && typeof p.text === "string");
  const finalMessage = textParts.length ? textParts[textParts.length - 1]!.text!.trim() : null;
  if (body.info.error) {
    return {
      finalMessage,
      failed: true,
      failureDetail: body.info.error.message ?? body.info.error.name ?? "opencode reported an error with no message",
    };
  }
  return { finalMessage, failed: false, failureDetail: null };
}

/** Generic forwarder for a proxied `opencode_request` (issue #81 follow-up, ADR 0026). */
export async function forwardRequest(
  baseUrl: string,
  req: { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${req.path}`, {
    method: req.method,
    headers: req.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/**
 * Subscribes to `GET /event` (SSE) and invokes `onEvent` for each parsed
 * event, forever, until `signal` aborts. Best-effort: a stream error just
 * stops forwarding (the live view goes stale) rather than crashing the agent
 * -- this is purely for a live viewer's benefit, never load-bearing for the
 * ordinary reply/prompt contract.
 */
export async function subscribeEvents(baseUrl: string, onEvent: (event: unknown) => void, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/event`, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        try {
          onEvent(JSON.parse(dataLines.join("\n")));
        } catch {
          // Non-JSON/keep-alive chunk -- ignore.
        }
      }
    }
  } catch {
    // Aborted, or the connection dropped -- best-effort, nothing to recover.
  }
}
