import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { Target } from "./allowlist.js";
import type { AppConfig } from "./config.js";

export class SshExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** Absolute path to the ssh binary (see Dockerfile) -- spawned directly,
 * never resolved via PATH, so the child process needs no inherited env. */
const SSH_BIN = process.env.SSH_BIN ?? "/usr/bin/ssh";

const KEY_PATH = "/tmp/ssh-tool/id_key";
const KNOWN_HOSTS_PATH = "/tmp/ssh-tool/known_hosts";

let materialized = false;

/**
 * Writes the secretEnv-injected private key and the operator-supplied
 * known_hosts content to disk (this container's root filesystem is
 * read-only, but /tmp is a writable emptyDir -- see the Job spec
 * core-controller builds). Done once per process, with the key at 0600 so
 * ssh's own "UNPROTECTED PRIVATE KEY FILE" check never fires.
 */
async function materializeCredentials(cfg: AppConfig): Promise<void> {
  if (materialized) return;
  if (!cfg.privateKey) {
    throw new Error("SSH_PRIVATE_KEY is not set -- this tool has no credential to authenticate with.");
  }
  if (!cfg.knownHosts) {
    throw new Error("SSH_KNOWN_HOSTS is not set -- refusing to connect without pinned host keys.");
  }
  await mkdir("/tmp/ssh-tool", { recursive: true, mode: 0o700 });
  await writeFile(KEY_PATH, cfg.privateKey.endsWith("\n") ? cfg.privateKey : `${cfg.privateKey}\n`, {
    mode: 0o600,
  });
  await writeFile(KNOWN_HOSTS_PATH, cfg.knownHosts, { mode: 0o600 });
  materialized = true;
}

/**
 * Runs a single allowlisted remote command over ssh via `spawn` -- never a
 * shell string locally, so nothing in the local argv can be reinterpreted as
 * local shell syntax. StrictHostKeyChecking stays on and BatchMode=yes means
 * ssh fails fast instead of ever prompting (there's no tty to prompt on
 * inside a Job pod). Returns combined stdout on success; throws
 * {@link SshExecError} on a non-zero exit.
 */
export async function runSsh(cfg: AppConfig, target: Target, remoteArgv: string[]): Promise<string> {
  await materializeCredentials(cfg);

  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
    "-o",
    `ConnectTimeout=${cfg.connectTimeoutSec}`,
    "-i",
    KEY_PATH,
    "-p",
    String(target.port),
    "--",
    `${target.user}@${target.host}`,
    ...remoteArgv,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(SSH_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, cfg.sshTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new SshExecError(`ssh exited with code ${code}`, stderr.trim(), code));
      }
    });
  });
}
