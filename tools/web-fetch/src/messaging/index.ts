import {
  CallbackSink,
  FileSink,
  JobEmitter as BaseJobEmitter,
  NatsSink,
  StdoutSink,
  type Sink,
} from "@controller-agent/messaging";
import type { AppConfig } from "../config.js";
import type { FetchErrorCode, FetchStage } from "../schema.js";
import { clip } from "../security/redact.js";

export type { Sink } from "@controller-agent/messaging";

/**
 * This tool's concrete emitter: a plain Markdown string as the `succeeded`
 * result (the fetched page rendered by ../markdown.ts), pipeline
 * {@link FetchStage}s, and {@link FetchErrorCode}s. Same thin-wiring pattern
 * as tools/web-search/src/messaging/index.ts.
 */
export class JobEmitter extends BaseJobEmitter<string, FetchStage, FetchErrorCode> {
  constructor(jobId: string, sink: Sink<string>) {
    super(jobId, sink, { sanitize: clip });
  }
}

/** Selects the event transport from configuration (same shape as recipe-scraper/web-search). */
export function createSink(cfg: AppConfig): Sink<string> {
  switch (cfg.transport) {
    case "events":
      return new StdoutSink<string>("ndjson");
    case "file":
      return new FileSink<string>(cfg.eventsPath);
    case "callback":
      if (!cfg.callbackUrl) {
        throw new Error("RECIPE_TRANSPORT=callback requires RECIPE_CALLBACK_URL");
      }
      return new CallbackSink<string>({
        url: cfg.callbackUrl,
        secret: cfg.callbackSecret,
        allowedHosts: cfg.callbackAllowedHosts,
        maxRetries: cfg.callbackMaxRetries,
      });
    case "nats":
      if (!cfg.natsUrl || !cfg.natsSubject) {
        throw new Error("RECIPE_TRANSPORT=nats requires RECIPE_NATS_URL and RECIPE_NATS_SUBJECT");
      }
      return new NatsSink<string>({ natsUrl: cfg.natsUrl, subject: cfg.natsSubject });
    case "stdout":
    default:
      return new StdoutSink<string>("final");
  }
}
