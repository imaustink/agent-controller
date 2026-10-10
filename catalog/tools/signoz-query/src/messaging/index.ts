import {
  CallbackSink,
  FileSink,
  JobEmitter as BaseJobEmitter,
  NatsSink,
  StdoutSink,
  type Sink,
} from "@controller-agent/messaging";
import type { AppConfig } from "../config.js";
import type { ErrorCode, Stage } from "../schema.js";
import { clip } from "../security/redact.js";

export type { Sink } from "@controller-agent/messaging";

/** This tool's concrete emitter: the result is a Markdown summary of the
 * SigNoz response, built by index.ts before it reaches `succeeded`. */
export class JobEmitter extends BaseJobEmitter<string, Stage, ErrorCode> {
  constructor(jobId: string, sink: Sink<string>) {
    super(jobId, sink, { sanitize: clip });
  }
}

export function createSink(cfg: AppConfig): Sink<string> {
  switch (cfg.transport) {
    case "events":
      return new StdoutSink<string>("ndjson");
    case "file":
      return new FileSink<string>(cfg.eventsPath);
    case "callback":
      if (!cfg.callbackUrl) {
        throw new Error("SIGNOZ_TRANSPORT=callback requires SIGNOZ_CALLBACK_URL");
      }
      return new CallbackSink<string>({
        url: cfg.callbackUrl,
        secret: cfg.callbackSecret,
        allowedHosts: cfg.callbackAllowedHosts,
        maxRetries: cfg.callbackMaxRetries,
      });
    case "nats":
      if (!cfg.natsUrl || !cfg.natsSubject) {
        throw new Error("SIGNOZ_TRANSPORT=nats requires SIGNOZ_NATS_URL and SIGNOZ_NATS_SUBJECT");
      }
      return new NatsSink<string>({ natsUrl: cfg.natsUrl, subject: cfg.natsSubject });
    case "stdout":
    default:
      return new StdoutSink<string>("final");
  }
}
