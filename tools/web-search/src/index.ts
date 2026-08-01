import { config } from "./config.js";
import { renderResults } from "./markdown.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { QueryInputSchema, type SearchErrorCode } from "./schema.js";
import { search, SearxngSearchError } from "./searxng/client.js";
import { clip } from "./security/redact.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  searchError: 3,
  general: 1,
} as const;

/**
 * A failure classified for both the process exit code and the structured
 * `failed` event -- same pattern as tools/recipe-publisher/src/index.ts.
 */
class PipelineError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: SearchErrorCode, exitCode: number, message: string): never {
  throw new PipelineError(code, exitCode, clip(message, 2000));
}

async function run(emitter: JobEmitter, rawQuery: string): Promise<void> {
  const query = QueryInputSchema.safeParse(rawQuery);
  if (!query.success) {
    fail("usage", EXIT.usage, `Invalid search query: ${query.error.message}`);
  }

  if (!config.searxngBaseUrl) {
    fail("usage", EXIT.usage, "SEARXNG_BASE_URL must be configured");
  }

  await emitter.progress("search");
  let results;
  try {
    results = await search(query.data, {
      baseUrl: config.searxngBaseUrl,
      fetchTimeoutMs: config.fetchTimeoutMs,
    });
  } catch (err) {
    if (err instanceof SearxngSearchError) {
      fail("search_error", EXIT.searchError, err.message);
    }
    throw err;
  }

  await emitter.succeeded(renderResults(query.data, results, config.maxResults));
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawQuery = process.argv[2];

  try {
    if (!rawQuery) {
      fail("usage", EXIT.usage, "Usage: web-search <query>");
    }
    await emitter.accepted(clip(rawQuery, 200));
    await run(emitter, rawQuery);
    await emitter.close();
  } catch (err) {
    const { code, exitCode, message } = toPipelineError(err);
    process.stderr.write(`${message}\n`);
    try {
      await emitter.failed(code, message);
      await emitter.close();
    } catch {
      // The event stream is best-effort on the failure path; the exit code
      // remains the authoritative backstop.
    }
    process.exit(exitCode);
  }
}

function toPipelineError(err: unknown): {
  code: SearchErrorCode;
  exitCode: number;
  message: string;
} {
  if (err instanceof PipelineError) {
    return { code: err.code, exitCode: err.exitCode, message: err.message };
  }
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
