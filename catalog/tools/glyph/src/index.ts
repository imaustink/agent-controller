import { CommandError, parseCommand } from "./commands.js";
import { config } from "./config.js";
import { runCommand } from "./execute.js";
import { GlyphApiError, GlyphClient } from "./glyph/client.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import type { ErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  invalidInput: 3,
  glyphError: 4,
  general: 1,
} as const;

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

async function run(emitter: JobEmitter, rawInput: string): Promise<void> {
  await emitter.progress("validate");

  if (!config.glyphBaseUrl || !config.glyphToken) {
    fail(
      "usage",
      EXIT.usage,
      "GLYPH_BASE_URL and GLYPH_TOKEN must be configured (the calling user's delegated Glyph token is injected per-invocation via secretEnv)",
    );
  }

  let command;
  try {
    command = parseCommand(rawInput);
  } catch (err) {
    if (err instanceof CommandError) {
      fail("invalid_input", EXIT.invalidInput, err.message);
    }
    throw err;
  }

  await emitter.progress("request", { message: `${command.resource} ${command.action}` });
  const client = new GlyphClient({
    baseUrl: config.glyphBaseUrl,
    token: config.glyphToken,
    fetchTimeoutMs: config.fetchTimeoutMs,
  });

  let result: string;
  try {
    result = await runCommand(client, command);
  } catch (err) {
    if (err instanceof GlyphApiError) {
      fail("glyph_error", EXIT.glyphError, glyphErrorMessage(err));
    }
    throw err;
  }

  await emitter.succeeded(result);
}

/** Turns a raw Glyph API failure into a message that hints at the likely cause (auth/scope/not-found). */
function glyphErrorMessage(err: GlyphApiError): string {
  switch (err.status) {
    case 401:
      return `Glyph rejected the request as unauthenticated (401) — the delegated token may be missing, expired, or revoked. ${err.message}`;
    case 403:
      return `Glyph denied the request (403) — the delegated token likely lacks the required scope (page:* / task:*) or the caller cannot access this resource. ${err.message}`;
    case 404:
      return `Glyph could not find the requested note/task (404). ${err.message}`;
    default:
      return err.message;
  }
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawInput = process.argv[2];

  try {
    if (!rawInput || rawInput.trim() === "") {
      fail(
        "usage",
        EXIT.usage,
        'Usage: glyph \'<json-command>\' (e.g. {"resource":"task","action":"create","title":"Ship the PR"})',
      );
    }
    await emitter.accepted(clip(rawInput, 500));
    await run(emitter, rawInput);
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
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
