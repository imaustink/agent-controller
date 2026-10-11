/**
 * Retry an async operation with exponential backoff.
 *
 * Added for the startup race where this pod comes up before its Qdrant
 * dependency does (common after a full-cluster restart, e.g. minikube):
 * the very first Qdrant call would throw `fetch failed` and the process
 * exited with EXIT_STARTUP_FAILURE, staying down until manually restarted.
 * Instead of crashing, wait for the dependency to become reachable.
 */
export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Delay before the second attempt; doubles each retry. */
  initialDelayMs: number;
  /** Upper bound on the per-retry delay. */
  maxDelayMs: number;
  /** Injectable for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to console.error. */
  log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(label: string, fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((message: string) => console.error(message));
  let delayMs = options.initialDelayMs;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === options.attempts) break;
      const reason = err instanceof Error ? err.message : String(err);
      log(`${label} failed (attempt ${attempt}/${options.attempts}): ${reason} -- retrying in ${delayMs}ms`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, options.maxDelayMs);
    }
  }
  throw lastError;
}
