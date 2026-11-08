import { execFileSync } from "node:child_process";
import { requireMinikubeContext } from "./guard.js";
import { NAMESPACE } from "./k8s.js";

/**
 * Which agent engine the deployed orchestrator drives turns with, and which one
 * the person running the suite MEANT to test.
 *
 *   temporal   AGENT_ENGINE=temporal on agent-orchestrator (the chart default,
 *              docs/adr/0036): turns run on the Go worker.
 *   langgraph  AGENT_ENGINE unset: the in-process LangGraph loop.
 *
 * `E2E_ENGINE` names the intended one. When it is set and the cluster runs the
 * other, {@link deployedEngine} THROWS rather than letting the suite pass against
 * an engine nobody asked about -- a langgraph run that silently exercised
 * temporal would report parity it never measured. Deploy a given engine with
 * `E2E_ENGINE=<engine> ./e2e/scripts/up.sh` (see e2e/README.md).
 *
 * Synchronous on purpose: specs gate whole describe blocks on it
 * (`describe.skipIf(...)`), which runs at collection time.
 */
export type Engine = "temporal" | "langgraph";

let cached: Engine | undefined;

export function deployedEngine(): Engine {
  if (cached) return cached;
  requireMinikubeContext();
  const raw = execFileSync(
    "kubectl",
    [
      "-n",
      NAMESPACE,
      "get",
      "deploy",
      "agent-orchestrator",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].env[?(@.name==\"AGENT_ENGINE\")].value}",
    ],
    { encoding: "utf8" },
  ).trim();
  const engine: Engine = raw === "temporal" ? "temporal" : "langgraph";

  const wanted = process.env.E2E_ENGINE;
  if (wanted !== undefined && wanted !== "") {
    if (wanted !== "temporal" && wanted !== "langgraph") {
      throw new Error(`e2e: E2E_ENGINE must be "temporal" or "langgraph", got "${wanted}"`);
    }
    if (wanted !== engine) {
      throw new Error(
        `e2e: E2E_ENGINE=${wanted} but the deployed agent-orchestrator runs ${engine} ` +
          `(AGENT_ENGINE=${raw === "" ? "<unset>" : raw}). Redeploy with: E2E_ENGINE=${wanted} ./e2e/scripts/up.sh`,
      );
    }
  }
  cached = engine;
  return engine;
}

/** True when the deployed engine is Temporal -- for `describe.skipIf(!isTemporal())` on Temporal-only behaviour. */
export const isTemporal = (): boolean => deployedEngine() === "temporal";
