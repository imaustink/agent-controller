import { ArtifactRefSchema, type ArtifactRef } from "./artifact.js";
import { EventSchema, type Event, type Disposition } from "./event.js";
import type { Sink } from "./sink.js";

/** Default free-text guard: bounds length only. Tools should inject a
 * stronger `sanitize` (e.g. one that also redacts secrets) since messages may
 * echo untrusted content the tool extracted. */
function defaultSanitize(input: string, max = 2000): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}

export interface JobEmitterOptions {
  /** Applied to every free-text field before it leaves the process. */
  sanitize?: (input: string, max?: number) => string;
}

/**
 * Builds well-formed, ordered {@link Event}s for a single job and hands them to
 * a {@link Sink}. Owns the monotonic sequence counter and timestamps so callers
 * only describe *what* happened.
 *
 * Generic over:
 * - `TResult` — the shape of a successful `result` (a tool's own envelope type).
 * - `TStage` — the string-literal union of pipeline stages a tool reports.
 * - `TCode` — the string-literal union of failure codes a tool reports.
 * - `TDisposition` — the vocabulary a tool uses on `reflection` events
 *   (defaults to the suggested {@link Disposition} union).
 *
 * These generics only narrow the TypeScript surface; the wire format always
 * stores `stage`/`code`/`disposition` as plain strings (see {@link EventSchema}).
 */
export class JobEmitter<
  TResult = unknown,
  TStage extends string = string,
  TCode extends string = string,
  TDisposition extends string = Disposition,
> {
  private seq = 0;
  private readonly sanitize: (input: string, max?: number) => string;

  constructor(
    private readonly jobId: string,
    private readonly sink: Sink<TResult>,
    options: JobEmitterOptions = {},
  ) {
    this.sanitize = options.sanitize ?? defaultSanitize;
  }

  private nextBase(): { job_id: string; seq: number; ts: string } {
    return { job_id: this.jobId, seq: this.seq++, ts: new Date().toISOString() };
  }

  private async emit(event: Event<TResult>): Promise<void> {
    // Validates envelope shape (job_id/seq/ts/type/artifacts); `result` itself
    // is a tool's own responsibility to validate before calling `succeeded`.
    EventSchema.parse(event);
    await this.sink.emit(event);
  }

  async accepted(url: string): Promise<void> {
    await this.emit({ ...this.nextBase(), type: "accepted", url });
  }

  async progress(stage: TStage, opts: { pct?: number; message?: string } = {}): Promise<void> {
    await this.emit({
      ...this.nextBase(),
      type: "progress",
      stage,
      pct: opts.pct,
      message: opts.message === undefined ? undefined : this.sanitize(opts.message, 500),
    });
  }

  async warning(message: string): Promise<void> {
    await this.emit({ ...this.nextBase(), type: "warning", message: this.sanitize(message, 500) });
  }

  /**
   * Emit an interstitial self-report of the job's current internal state: a
   * `disposition` (see {@link Disposition}), an optional `confidence` in
   * `[0, 1]`, and an optional free-text `note`. Non-terminal — a job may emit
   * as many as it likes between `accepted` and its terminal event, or none.
   *
   * This is observability, not sentience: it surfaces the reasoning state a
   * consumer would otherwise have to infer from logs, so uncertainty and being
   * stuck become first-class, alertable signals rather than silence.
   */
  async reflection(
    disposition: TDisposition,
    opts: { confidence?: number; note?: string } = {},
  ): Promise<void> {
    await this.emit({
      ...this.nextBase(),
      type: "reflection",
      disposition,
      confidence: opts.confidence,
      note: opts.note === undefined ? undefined : this.sanitize(opts.note, 500),
    });
  }

  async succeeded(result: TResult, artifacts?: ArtifactRef[]): Promise<void> {
    if (artifacts) artifacts.forEach((a) => ArtifactRefSchema.parse(a));
    await this.emit({ ...this.nextBase(), type: "succeeded", result, artifacts });
  }

  async failed(code: TCode, message: string): Promise<void> {
    await this.emit({ ...this.nextBase(), type: "failed", code, message: this.sanitize(message, 2000) });
  }

  close(): Promise<void> {
    return this.sink.close();
  }
}
