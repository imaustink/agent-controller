import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";

export class KubectlExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/**
 * Builds the in-cluster auth flags kubectl needs on every invocation.
 * kubectl (unlike client-go/client-node libraries) has no automatic
 * in-cluster mode, so the projected ServiceAccount token + CA are read fresh
 * on each call and passed explicitly -- never persisted to a kubeconfig file
 * on disk (this container's root filesystem is read-only).
 */
async function authArgs(cfg: AppConfig): Promise<string[]> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    throw new Error(
      "KUBERNETES_SERVICE_HOST/PORT are not set -- this tool must run inside a Kubernetes pod.",
    );
  }
  const token = (await readFile(cfg.serviceAccountTokenPath, "utf8")).trim();
  return [
    `--server=https://${host}:${port}`,
    `--certificate-authority=${cfg.serviceAccountCaPath}`,
    `--token=${token}`,
  ];
}

/** Absolute path to the kubectl binary (see Dockerfile) -- spawned directly,
 * never resolved via PATH, so the child process needs no inherited env. */
const KUBECTL_BIN = process.env.KUBECTL_BIN ?? "/usr/local/bin/kubectl";

/**
 * Runs kubectl with the given (already-allowlisted) argv via `spawn` --
 * never a shell string, so nothing in argv can be reinterpreted as shell
 * syntax. Returns combined result on success; throws {@link KubectlExecError}
 * on a non-zero exit.
 */
export async function runKubectl(cfg: AppConfig, argv: string[]): Promise<string> {
  const fullArgv = [...argv, ...(await authArgs(cfg))];

  return new Promise((resolve, reject) => {
    const child = spawn(KUBECTL_BIN, fullArgv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, cfg.kubectlTimeoutMs);

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
        reject(new KubectlExecError(`kubectl exited with code ${code}`, stderr.trim(), code));
      }
    });
  });
}
