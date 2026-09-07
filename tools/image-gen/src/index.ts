import { createHash } from "node:crypto";
import type { ArtifactRef } from "@controller-agent/messaging";
import { config } from "./config.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { editImage, generateImage } from "./openai/images.js";
import { renderResult } from "./render.js";
import { parseInput, type ErrorCode, type ToolInput } from "./schema.js";
import { clip } from "./security/redact.js";
import { UrlGuardError } from "./security/url-guard.js";
import { objectKey, StorageError, uploadAndPresign } from "./storage/s3.js";
import { downloadBytes } from "./util/download.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  blockedUrl: 3,
  provider: 4,
  storage: 5,
  general: 1,
} as const;

/**
 * A failure classified for both the process exit code and the structured
 * `failed` event -- same pattern as tools/web-fetch/src/index.ts.
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

async function run(emitter: JobEmitter, input: ToolInput): Promise<void> {
  // Generate vs edit is decided purely by whether a source image was supplied.
  let produced;
  if (input.image_url) {
    await emitter.progress("download");
    let source;
    try {
      source = await downloadBytes(input.image_url, config.maxImageBytes);
    } catch (err) {
      if (err instanceof UrlGuardError) throw err; // mapped to blocked_url below
      fail("provider_error", EXIT.provider, `Could not download source image: ${(err as Error).message}`);
    }

    await emitter.progress("edit");
    try {
      produced = await editImage(input, source.bytes, source.contentType || "image/png");
    } catch (err) {
      fail("provider_error", EXIT.provider, `Image edit failed: ${(err as Error).message}`);
    }
  } else {
    await emitter.progress("generate");
    try {
      produced = await generateImage(input);
    } catch (err) {
      fail("provider_error", EXIT.provider, `Image generation failed: ${(err as Error).message}`);
    }
  }

  await emitter.progress("upload");
  const key = objectKey(config.jobId);
  const contentType = "image/png";
  let url: string;
  try {
    url = await uploadAndPresign(key, produced.bytes, contentType);
  } catch (err) {
    if (err instanceof StorageError) {
      fail("storage_error", EXIT.storage, err.message);
    }
    fail("storage_error", EXIT.storage, `Upload failed: ${(err as Error).message}`);
  }

  const artifact: ArtifactRef = {
    uri: url,
    sha256: createHash("sha256").update(produced.bytes).digest("hex"),
    bytes: produced.bytes.byteLength,
    content_type: contentType,
  };

  await emitter.succeeded(renderResult(input, url), [artifact]);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const raw = process.argv[2];

  try {
    if (!raw) {
      fail("usage", EXIT.usage, 'Usage: image-gen \'{"prompt":"...","image_url":"..."}\' (or a bare prompt string)');
    }
    let input: ToolInput;
    try {
      input = parseInput(raw);
    } catch (err) {
      fail("usage", EXIT.usage, `Invalid input: ${(err as Error).message}`);
    }
    await emitter.accepted(clip(input.image_url ? `edit: ${input.prompt}` : input.prompt, 200));
    await run(emitter, input);
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

function toPipelineError(err: unknown): { code: ErrorCode; exitCode: number; message: string } {
  if (err instanceof PipelineError) {
    return { code: err.code, exitCode: err.exitCode, message: err.message };
  }
  if (err instanceof UrlGuardError) {
    return {
      code: "blocked_url",
      exitCode: EXIT.blockedUrl,
      message: clip(`Blocked image URL: ${err.message}`, 2000),
    };
  }
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
