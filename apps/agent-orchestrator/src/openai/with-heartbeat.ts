/**
 * Wraps an async iterable so the consumer also receives periodic
 * `{ type: "heartbeat" }` items whenever the source hasn't produced a value
 * within `intervalMs` — used to keep an SSE connection alive (bytes flowing)
 * while a slow upstream step (e.g. waiting on a tool Job) is in progress,
 * without changing what the source itself yields.
 */
export type HeartbeatItem<T> = { type: "chunk"; value: T } | { type: "heartbeat" };

export async function* withHeartbeat<T>(source: AsyncIterable<T>, intervalMs: number): AsyncGenerator<HeartbeatItem<T>> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();

  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), intervalMs);
    });

    const winner = await Promise.race([pending, timeout]);
    if (winner === "timeout") {
      yield { type: "heartbeat" };
      continue;
    }

    clearTimeout(timer);
    const result = winner as IteratorResult<T>;
    if (result.done) return;
    yield { type: "chunk", value: result.value };
    pending = iterator.next();
  }
}
