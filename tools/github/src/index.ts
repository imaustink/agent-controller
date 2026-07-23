import { BlockedCommandError, tokenize, validateCommand } from "./allowlist.js";
import { config } from "./config.js";
import { GhExecError, runGh } from "./github.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import type { ErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  blockedCommand: 3,
  ghError: 4,
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

async function run(emitter: JobEmitter, commandLine: string): Promise<void> {
  await emitter.progress("validate");
  let argv: string[];
  try {
    argv = validateCommand(tokenize(commandLine));
  } catch (err) {
    if (err instanceof BlockedCommandError) {
      fail("blocked_command", EXIT.blockedCommand, err.message);
    }
    throw err;
  }

  await emitter.progress("exec", { message: argv.join(" ") });
  let stdout: string;
  try {
    stdout = await runGh(config, argv);
  } catch (err) {
    if (err instanceof GhExecError) {
      fail("gh_error", EXIT.ghError, `gh failed: ${err.stderr || err.message}`);
    }
    throw err;
  }

  const isJson = argv.some((a) => a === "--json" || a.startsWith("--json="));
  const lang = isJson ? "json" : "text";
  await emitter.succeeded(`\`\`\`${lang}\n${stdout.trim()}\n\`\`\``);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const commandLine = process.argv[2];

  try {
    if (!commandLine) {
      fail(
        "usage",
        EXIT.usage,
        'Usage: github "<gh-command> [flags]" (e.g. "issue view 86 --repo owner/repo --json title,body")',
      );
    }
    await emitter.accepted(clip(commandLine, 500));
    await run(emitter, commandLine);
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
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
