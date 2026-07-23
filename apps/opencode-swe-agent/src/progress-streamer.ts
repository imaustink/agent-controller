/**
 * opencode's headless `run --format json` mode narrates by emitting one
 * whole message/tool-output block per JSONL line -- there is no confirmed
 * per-token delta event in real production output (see opencode.test.ts's
 * captured fixtures, and the `text-delta`/`reasoning-delta` handling in
 * opencode.ts, which exists defensively but has never been observed). When
 * each whole block is forwarded to the chat UI as a single `session.progress()`
 * call, the result is jarring: entire paragraphs (or tool-output dumps) pop
 * in all at once rather than streaming smoothly like a real token-by-token
 * response.
 *
 * `ProgressStreamer` fakes that smoothness at the point where we already
 * have a whole (already-clipped/redacted) text block: it queues each block
 * and emits it as a sequence of small, word-boundary-aligned chunks a short
 * delay apart, giving the same "typing" effect a genuine per-token stream
 * would produce -- without changing opencode's invocation or the rest of the
 * progress/NATS/SSE pipeline, which already forwards whatever granularity of
 * `progress` message it's given (see apps/agent-orchestrator/src/server.ts).
 */
export interface ProgressStreamerOptions {
  /** Approx. chars per emitted chunk (word-boundary aligned where possible). Default 16. */
  chunkSize?: number;
  /** Delay between emitted chunks, in ms. Default 80. */
  delayMs?: number;
  /**
   * When aborted, any already-queued text is still emitted (nothing is
   * dropped), but with no further inter-chunk delay -- so a cancelled run
   * doesn't hang around waiting out a typing effect nobody will see.
   */
  signal?: AbortSignal;
}

export class ProgressStreamer {
  private readonly chunkSize: number;
  private readonly delayMs: number;
  private readonly signal?: AbortSignal;
  private readonly queue: string[] = [];
  private draining: Promise<void> | undefined;

  constructor(
    /** Called once per emitted chunk, in order. */
    private readonly emit: (chunk: string) => void,
    opts: ProgressStreamerOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? 16;
    this.delayMs = opts.delayMs ?? 80;
    this.signal = opts.signal;
  }

  /** Queues one whole (already-clipped/redacted) text block for smoothed emission. */
  push(text: string): void {
    if (!text) return;
    this.queue.push(text);
    if (!this.draining) {
      // NOTE: if the whole queue drains without ever hitting an `await`
      // (e.g. it's already aborted, or the very first block is short enough
      // to be a single chunk), `this.drain()` below runs synchronously to
      // completion *before this assignment happens* -- so clearing
      // `this.draining` can't safely happen inside `drain()` itself (that
      // reset would run first, then get clobbered by this assignment,
      // leaving `this.draining` permanently pointing at an already-settled
      // promise and deadlocking `waitUntilDrained`'s loop below). Chaining
      // the reset onto the returned promise defers it to a microtask, which
      // always runs after this synchronous assignment completes.
      const running = this.drain();
      this.draining = running;
      void running.finally(() => {
        if (this.draining === running) this.draining = undefined;
      });
    }
  }

  /**
   * Resolves once every currently-queued block has been fully emitted. Call
   * this before moving on to a new progress stage so messages stay in the
   * order opencode actually produced them.
   */
  async waitUntilDrained(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const text = this.queue.shift()!;
      const chunks = splitIntoChunks(text, this.chunkSize);
      for (let i = 0; i < chunks.length; i++) {
        this.emit(chunks[i]!);
        const isLast = i === chunks.length - 1 && this.queue.length === 0;
        if (!isLast && !this.signal?.aborted) await sleep(this.delayMs);
      }
    }
  }
}

/**
 * Splits `text` into pieces of roughly `size` characters, preferring to
 * break on whitespace within the window so words aren't split mid-token
 * (matches how a real token stream tends to land). Falls back to a hard cut
 * if there's no whitespace to break on (e.g. one very long token).
 */
export function splitIntoChunks(text: string, size: number): string[] {
  if (size <= 0 || text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
