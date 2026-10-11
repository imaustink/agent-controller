import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Max bytes buffered per stream before further output is dropped. */
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs an external binary WITHOUT a shell (arguments are passed as an array, so
 * there is no shell-injection surface even if arguments contain metacharacters
 * from untrusted URLs). Enforces a hard timeout and output cap.
 */
export function execFile(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outLen += chunk.length;
      if (outLen <= maxBuffer) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errLen += chunk.length;
      if (errLen <= maxBuffer) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}
