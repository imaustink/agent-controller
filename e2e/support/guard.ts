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

/**
 * Local throwaway clusters the suite may also run against.
 *
 * Same rule as REQUIRED_CONTEXT, same reason: every name here must be a
 * cluster that exists only to be destroyed. "ferry-e2e" is the context
 * `FERRY_PROFILE=e2e ferry kubeconfig --merge` writes, whose state lives in
 * ~/.ferry-e2e and whose ports and pod network are isolated from the default
 * ferry profile. It is NOT a general override: there is still no environment
 * variable, and adding a name here is a deliberate source edit.
 */
const ALLOWED_CONTEXTS = [REQUIRED_CONTEXT, "ferry-e2e"];

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

  if (!ALLOWED_CONTEXTS.includes(current)) {
    throw new Error(
      [
        `e2e: refusing to run against kubectl context "${current}".`,
        `These tests create and delete cluster objects and may ONLY run against: ${
          ALLOWED_CONTEXTS.map((c) => `"${c}"`).join(", ")
        }.`,
        `Switch with:  kubectl config use-context ${REQUIRED_CONTEXT}`,
      ].join("\n"),
    );
  }

  verified = true;
}
