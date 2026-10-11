import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `config` reads the environment once at module load, so each case loads a
 * fresh copy with vi.resetModules after setting env.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import("./config.js")).config;
}

describe("knowledgeBaseNamespace", () => {
  afterEach(() => {
    delete process.env.KNOWLEDGE_BASE_NAMESPACE;
    delete process.env.AGENT_NAMESPACE;
  });

  it("uses KNOWLEDGE_BASE_NAMESPACE when set, independent of AGENT_NAMESPACE", async () => {
    const config = await loadConfig({ AGENT_NAMESPACE: "agent-controller", KNOWLEDGE_BASE_NAMESPACE: "knowledge-bases" });
    // The whole point: KB CRs can live in a namespace separate from where
    // tools/agents and Jobs do.
    expect(config.knowledgeBaseNamespace).toBe("knowledge-bases");
    expect(config.namespace).toBe("agent-controller");
  });

  it("falls back to AGENT_NAMESPACE so single-namespace deployments are unchanged", async () => {
    const config = await loadConfig({ AGENT_NAMESPACE: "agent-controller", KNOWLEDGE_BASE_NAMESPACE: undefined });
    expect(config.knowledgeBaseNamespace).toBe("agent-controller");
  });
});
