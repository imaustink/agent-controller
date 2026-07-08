import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventSchema, type Event } from "@recipe-agent/messaging";

export class CallbackAuthError extends Error {}

/**
 * Verifies the `x-signature: sha256=<hmac>` header written by
 * `@recipe-agent/messaging`'s `CallbackSink`, then validates the body against
 * the shared `EventSchema`. Kept as a pure function so it's testable without
 * binding a real socket.
 */
export function verifyAndParseCallback(rawBody: string, signatureHeader: string | undefined, secret: string): Event {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = signatureHeader ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new CallbackAuthError("Callback signature mismatch");
  }
  const parsed: unknown = JSON.parse(rawBody);
  // Cast: zod's inferred output type for the discriminated union doesn't
  // structurally match the hand-written `Event` type 1:1 (optionality of
  // `z.unknown()` fields), even though they describe the same wire shape.
  return EventSchema.parse(parsed) as Event;
}

type PendingJob = {
  resolve: (event: Event) => void;
  reject: (err: Error) => void;
};

/**
 * HTTP receiver for the Job -> orchestrator result channel (docs/messaging.md,
 * reused rather than reinvented per docs/orchestrator.md#4-kubernetes-job-launcher).
 * `awaitJob` resolves once a terminal (`succeeded`/`failed`) event arrives for
 * a given `job_id`; intermediate `progress`/`warning` events are currently
 * dropped (no streaming consumer yet — see open questions in
 * docs/orchestrator.md).
 */
export class CallbackReceiver {
  private server: Server | undefined;
  private readonly pending = new Map<string, PendingJob>();

  constructor(private readonly secret: string) {}

  awaitJob(jobId: string): Promise<Event> {
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
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
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    // Correlate by the URL path segment (`/callback/<jobId>`), NOT by the
    // body's `event.job_id` -- that field is set by whatever job_id the
    // *tool* generates internally (see e.g. tools/recipe-scraper/src/config.ts
    // `RECIPE_JOB_ID ?? randomUUID()`), which has no guaranteed relationship
    // to the id this orchestrator process is awaiting on. Historically these
    // matched by convention (an env var meant to force the tool to reuse the
    // orchestrator's id), but that env var's name never actually matched what
    // the tool reads, AND the ToolRun CRD (ADR 0010) has no per-invocation
    // custom-env field to carry it at all -- so relying on the body was
    // silently unreliable. The callback URL path is always correct end-to-end
    // (it's threaded through ToolRun.spec.callback.url -> RECIPE_CALLBACK_URL
    // verbatim), so it's the only trustworthy correlation key.
    const jobId = new URL(req.url ?? "", "http://callback.invalid").pathname.split("/").filter(Boolean).pop();
    const rawBody = await readBody(req);
    let event: Event;
    try {
      event = verifyAndParseCallback(rawBody, req.headers["x-signature"] as string | undefined, this.secret);
    } catch {
      res.writeHead(401).end();
      return;
    }

    if (jobId && (event.type === "succeeded" || event.type === "failed")) {
      const pending = this.pending.get(jobId);
      if (pending) {
        this.pending.delete(jobId);
        pending.resolve(event);
      }
    }
    res.writeHead(202).end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
