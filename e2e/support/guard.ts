import { execFileSync } from "node:child_process";

/**
 * The ONLY kubectl context these tests may touch.
 *
 * Deliberately a hardcoded constant with no environment-variable override.
 * The maintainer's default context is a live cluster running the real
 * deployment, these tests create and delete namespaced objects, and the
 * failure mode of "ran the suite against the wrong cluster" is destructive
 * and not obviously recoverable. An override flag would exist purely to be
 * set by accident in CI.
 */
const REQUIRED_CONTEXT = "minikube";

let verified = false;

/**
 * Aborts unless kubectl is pointed at minikube. Every spec file calls this at
 * module scope, before any fixture allocates anything, so a misconfigured run
 * fails on import rather than midway through creating objects somewhere it
 * shouldn't.
 *
 * Memoized: the check shells out, and every spec calling it would otherwise
 * pay for it repeatedly in a serial suite.
 */
export function requireMinikubeContext(): void {
  if (verified) return;

  let current: string;
  try {
    current = execFileSync("kubectl", ["config", "current-context"], { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(
      `e2e: could not determine the kubectl context (is kubectl installed and configured?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (current !== REQUIRED_CONTEXT) {
    throw new Error(
      [
        `e2e: refusing to run against kubectl context "${current}".`,
        `These tests create and delete cluster objects and may ONLY run against "${REQUIRED_CONTEXT}".`,
        `Switch with:  kubectl config use-context ${REQUIRED_CONTEXT}`,
      ].join("\n"),
    );
  }

  verified = true;
}
