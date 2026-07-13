import { classify } from "./classify.js";
import { config } from "./config.js";
import { extractImage } from "./extractors/image.js";
import { extractTikTokPhoto } from "./extractors/tiktok-photo.js";
import { extractVideo } from "./extractors/video.js";
import { extractWeb } from "./extractors/web.js";
import { formatRecipe } from "./llm/format.js";
import { renderMarkdown } from "./markdown.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { sanitizeTitle } from "./sanitize-title.js";
import { EnvelopeSchema, type ErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";
import { assertUrlAllowed, UrlGuardError } from "./security/url-guard.js";
import type { Extraction } from "./types.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  blockedUrl: 3,
  extraction: 4,
  formatting: 5,
  general: 1,
} as const;

/**
 * A failure classified for both the process exit code and the structured
 * `failed` event. Thrown by {@link fail} and handled centrally in {@link main}
 * so the event stream is always closed cleanly before the process exits.
 */
class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ErrorCode, exitCode: number, message: string): never {
  throw new PipelineError(code, exitCode, clip(message, 2000));
}

async function run(emitter: JobEmitter, rawUrl: string): Promise<void> {
  const safe = await assertUrlAllowed(rawUrl);

  await emitter.progress("classify");
  const sourceType = await classify(safe);

  let extraction: Extraction;
  await emitter.progress("extract", { message: sourceType });
  try {
    switch (sourceType) {
      case "video":
        extraction = await extractVideo(safe.url.toString());
        break;
      case "image":
        extraction = await extractImage(safe.url.toString());
        break;
      case "web":
        extraction = await extractWeb(safe);
        break;
      case "tiktok_photo":
        extraction = await extractTikTokPhoto(safe);
        break;
    }
  } catch (err) {
    fail("extraction", EXIT.extraction, `Extraction failed: ${(err as Error).message}`);
  }

  const warnings = [...extraction.warnings];
  if (!extraction.text.trim()) {
    warnings.push("No text content was extracted from the source");
  }
  for (const warning of warnings) {
    await emitter.warning(warning);
  }

  let recipe;
  await emitter.progress("format");
  try {
    recipe = await formatRecipe(extraction.text);
  } catch (err) {
    fail("formatting", EXIT.formatting, `Recipe formatting failed: ${(err as Error).message}`);
  }

  const envelope = EnvelopeSchema.parse({
    source_type: sourceType,
    url: rawUrl,
    title: recipe.name ?? sanitizeTitle(extraction.title),
    recipe,
    provenance: { ...extraction.provenance, sourceType },
    warnings,
  });

  // The result is rendered Markdown (not the raw envelope JSON) -- easier for
  // a user to read, and easier for the orchestrator's skill to make targeted
  // edits to in a later turn. `envelope` itself is still validated above
  // (defense-in-depth over the LLM's structured output) even though only its
  // rendering is sent onward.
  await emitter.succeeded(renderMarkdown(envelope));
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawUrl = process.argv[2];

  try {
    if (!rawUrl) {
      fail("usage", EXIT.usage, "Usage: recipe-scraper <url>");
    }
    await emitter.accepted(rawUrl);
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
  code: ErrorCode;
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
