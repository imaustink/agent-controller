import { BlockedCommandError, BlockedTargetError, tokenize, validateCommand, validateTarget } from "./allowlist.js";
import { config } from "./config.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import type { ErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";
import { runSsh, SshExecError } from "./ssh.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  blockedTarget: 3,
  blockedCommand: 4,
  sshError: 5,
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
  const [rawTarget, ...commandTokens] = tokenize(commandLine);
  if (!rawTarget) {
    fail("usage", EXIT.usage, 'Usage: ssh-tool "<target> <command> [args...]" (e.g. "nas.kurpuis.internal df -h")');
  }

  let target: ReturnType<typeof validateTarget>;
  try {
    target = validateTarget(rawTarget, config.allowedHosts);
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      fail("blocked_target", EXIT.blockedTarget, err.message);
    }
    throw err;
  }

  let argv: string[];
  try {
    argv = validateCommand(commandTokens);
  } catch (err) {
    if (err instanceof BlockedCommandError) {
      fail("blocked_command", EXIT.blockedCommand, err.message);
    }
    throw err;
  }

  await emitter.progress("connect", { message: `${target.user}@${target.host}:${target.port}` });
  await emitter.progress("exec", { message: argv.join(" ") });
  let stdout: string;
  try {
    stdout = await runSsh(config, target, argv);
  } catch (err) {
    if (err instanceof SshExecError) {
      fail("ssh_error", EXIT.sshError, `ssh failed: ${err.stderr || err.message}`);
    }
    throw err;
  }

  await emitter.succeeded(`\`\`\`text\n${stdout.trim()}\n\`\`\``);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const commandLine = process.argv[2];

  try {
    if (!commandLine) {
      fail("usage", EXIT.usage, 'Usage: ssh-tool "<target> <command> [args...]" (e.g. "nas.kurpuis.internal df -h")');
    }
    if (config.allowedHosts.length === 0) {
      fail("usage", EXIT.usage, "SSH_ALLOWED_HOSTS is not set -- this tool has no allowlisted targets to connect to.");
    }
    await emitter.accepted(commandLine);
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
