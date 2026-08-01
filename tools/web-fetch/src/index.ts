import { config } from "./config.js";
import { ExtractionError, extractPage } from "./extract.js";
import { renderPage } from "./markdown.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { UrlInputSchema, type FetchErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";
import { assertUrlAllowed, UrlGuardError } from "./security/url-guard.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  blockedUrl: 3,
  fetchError: 4,
  extraction: 5,
  general: 1,
} as const;

/**
 * A failure classified for both the process exit code and the structured
 * `failed` event -- same pattern as tools/recipe-scraper/src/index.ts.
 */
class PipelineError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: FetchErrorCode, exitCode: number, message: string): never {
  throw new PipelineError(code, exitCode, clip(message, 2000));
}

async function run(emitter: JobEmitter, rawUrl: string): Promise<void> {
  const input = UrlInputSchema.safeParse(rawUrl);
  if (!input.success) {
    fail("usage", EXIT.usage, `Invalid URL: ${input.error.message}`);
  }

  const safe = await assertUrlAllowed(input.data);

  await emitter.progress("fetch");
  await emitter.progress("extract");
  let extraction;
  try {
    extraction = await extractPage(safe);
  } catch (err) {
    if (err instanceof ExtractionError) {
      fail("extraction_error", EXIT.extraction, err.message);
    }
    fail("fetch_error", EXIT.fetchError, `Fetch failed: ${(err as Error).message}`);
  }

  if (!extraction.text.trim()) {
    fail("extraction_error", EXIT.extraction, "No text content was extracted from the page");
  }

  await emitter.succeeded(renderPage(safe.url.toString(), extraction, config.maxChars));
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawUrl = process.argv[2];

  try {
    if (!rawUrl) {
      fail("usage", EXIT.usage, "Usage: web-fetch <url>");
    }
    await emitter.accepted(clip(rawUrl, 200));
    await run(emitter, rawUrl);
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
  code: FetchErrorCode;
  exitCode: number;
  message: string;
} {
  if (err instanceof PipelineError) {
    return { code: err.code, exitCode: err.exitCode, message: err.message };
  }
  if (err instanceof UrlGuardError) {
    return {
      code: "blocked_url",
      exitCode: EXIT.blockedUrl,
      message: clip(`Blocked URL: ${err.message}`, 2000),
    };
  }
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
