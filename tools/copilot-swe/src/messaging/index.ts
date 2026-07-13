import {
  CallbackSink,
  FileSink,
  JobEmitter as BaseJobEmitter,
  StdoutSink,
  type Sink,
} from "@controller-agent/messaging";
import type { AppConfig } from "../config.js";
import type { SweErrorCode, SweStage } from "../schema.js";
import { clip } from "../security/redact.js";

export type { Sink } from "@controller-agent/messaging";

/**
 * This tool's concrete emitter: a plain Markdown string as the `succeeded`
 * result (an `<!-- swe: ... -->` marker + the agent's summary + the pull
 * request link, built in index.ts — same "render to a string" convention the
 * recipe tools use), pipeline {@link SweStage}s, and {@link SweErrorCode}s.
 * Injects this tool's `clip` (which redacts GitHub tokens and the App private
 * key) instead of the base's length-only sanitize.
 */
export class JobEmitter extends BaseJobEmitter<string, SweStage, SweErrorCode> {
  constructor(jobId: string, sink: Sink<string>) {
    super(jobId, sink, { sanitize: clip });
  }
}

/** Selects the event transport from configuration (same shape as the recipe tools). */
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
    case "stdout":
    default:
      return new StdoutSink<string>("final");
  }
}
