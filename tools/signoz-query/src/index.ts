import { config } from "./config.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import type { ErrorCode } from "./schema.js";
import { QuerySchema } from "./schema.js";
import { clip } from "./security/redact.js";
import { buildQueryRangePayload, InvalidQueryError, queryRange, resolveRange, SignozRequestError } from "./signoz.js";

const EXIT = {
  usage: 2,
  invalidQuery: 3,
  signozError: 4,
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    fail("usage", EXIT.usage, "Input must be a single JSON object describing the query.");
  }
  const result = QuerySchema.safeParse(parsed);
  if (!result.success) {
    fail("invalid_query", EXIT.invalidQuery, `Invalid query: ${result.error.message}`);
  }
  const query = result.data;

  let range;
  let payload;
  try {
    range = resolveRange(query, config, Date.now());
    payload = buildQueryRangePayload(query, range);
  } catch (err) {
    if (err instanceof InvalidQueryError) {
      fail("invalid_query", EXIT.invalidQuery, err.message);
    }
    throw err;
  }

  await emitter.progress("query", { message: `${query.signal} ${query.start}..${query.end}` });
  let response: unknown;
  try {
    response = await queryRange(config, payload, config.fetchTimeoutMs);
  } catch (err) {
    if (err instanceof SignozRequestError) {
      fail("signoz_error", EXIT.signozError, `SigNoz request failed (${err.status}): ${clip(err.body, 1000)}`);
    }
    fail("signoz_error", EXIT.signozError, `SigNoz request failed: ${(err as Error).message}`);
  }

  await emitter.succeeded(`\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawInput = process.argv[2];

  try {
    if (!rawInput) {
      fail(
        "usage",
        EXIT.usage,
        'Usage: signoz-query \'{"signal":"logs","start":"-1h","end":"now","serviceName":"checkout"}\'',
      );
    }
    await emitter.accepted(rawInput);
    await run(emitter, rawInput);
    await emitter.close();
  } catch (err) {
    const { code, exitCode, message } = toPipelineError(err);
    process.stderr.write(`${message}\n`);
    try {
      await emitter.failed(code, message);
      await emitter.close();
    } catch {
      // best-effort on the failure path; exit code is authoritative
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
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
