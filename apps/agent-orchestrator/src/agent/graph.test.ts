import { describe, expect, it, vi } from "vitest";
import type { Event } from "@controller-agent/messaging";
import { buildAgentGraph, type AgentGraphDeps } from "./graph.js";
import type { IdentityResolver } from "../rbac/types.js";
import type { SkillStore } from "../skills/types.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { SkillSelector } from "./skill-selector.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner, PlannedAction } from "./action-planner.js";
import type { ResponseComposer } from "./response-composer.js";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { SkillFitChecker } from "./skill-fit-checker.js";
import type { AgentDescriptor, AgentStore } from "../agents/types.js";
import type { DelegateSelector } from "./delegate-selector.js";
import type { AgentOrchestratorChannel, AgentTurnResult } from "../agents/nats-agent-channel.js";
import type { AgentRunLauncherPort } from "../k8s/agentrun-launcher.js";
import type { ToolFitChecker } from "./tool-fit-checker.js";
import type { BestEffortResponder } from "./best-effort-responder.js";
import type { CapabilityNeedChecker } from "./capability-need-checker.js";
import type { IdentityLinkPort } from "../identity-link/gateway-client.js";

const scraperTool: ToolDescriptor = {
  id: "recipe-scraper",
  name: "recipe-scraper",
  description: "Scrapes a recipe from a URL",
  allowedRoles: ["reader"],
  jobTemplate: { image: "example.com/recipe-scraper:latest", namespace: "default", serviceAccountName: "sa" },
};

const publisherTool: ToolDescriptor = {
  id: "recipe-publisher",
  name: "recipe-publisher",
  description: "Publishes a recipe to GitHub",
  allowedRoles: ["reader"],
  jobTemplate: { image: "example.com/recipe-publisher:latest", namespace: "default", serviceAccountName: "sa" },
};

const skill: SkillDescriptor = {
  id: "recipe-publisher-skill",
  name: "Recipe Extraction & Publishing",
  description: "Extract, adjust, and publish recipes",
  markdown: "# instructions",
  toolIds: ["recipe-scraper", "recipe-publisher"],
  agentIds: [],
};

function baseDeps(overrides: Partial<AgentGraphDeps> = {}): AgentGraphDeps {
  const identityResolver: IdentityResolver = {
    resolve: vi.fn().mockResolvedValue({ subject: "alice", roles: ["reader"] }),
  };
  const skillStore: SkillStore = {
    upsert: vi.fn(),
    delete: vi.fn(),
    query: vi.fn().mockResolvedValue([{ skill, score: 0.9 }]),
    getByIds: vi.fn().mockResolvedValue([skill]),
  };
  const skillSelector: SkillSelector = { select: vi.fn().mockResolvedValue(skill) };
  const skillFitChecker: SkillFitChecker = { fits: vi.fn().mockResolvedValue(true) };
  const vectorStore: VectorStore = {
    upsert: vi.fn(),
    delete: vi.fn(),
    // Defaults to no fallback-tool candidates (graph.ts's selectFallbackTool)
    // so tests that don't care about that path aren't broken by it; override
    // per-test when exercising the fallback-tool-fit cascade.
    query: vi.fn().mockResolvedValue([]),
    getByIds: vi.fn().mockResolvedValue([
      { tool: scraperTool, score: 1 },
      { tool: publisherTool, score: 1 },
    ]),
  };
  const actionPlanner: ActionPlanner = {
    plan: vi.fn().mockResolvedValue({
      action: "call_tool",
      toolId: "recipe-scraper",
      toolArgs: "https://example.com/recipe",
    } satisfies PlannedAction),
  };
  const containerToolLauncher = { launch: vi.fn().mockResolvedValue({ name: "tool-1", namespace: "default" }) } as unknown as ContainerToolLauncher;
  const responseComposer: ResponseComposer = {
    compose: vi.fn().mockResolvedValue({ prefix: null, suffix: null }),
  };
  const callbackReceiver = {
    awaitJob: vi.fn().mockResolvedValue({
      type: "succeeded",
      job_id: "job-1",
      seq: 1,
      ts: new Date().toISOString(),
      result: { title: "Pancakes" },
    } satisfies Event),
  } as unknown as JobResultReceiver;
  // Defaults to "fits" so tests exercising the fallback-tool path don't need
  // to mock this explicitly; override per-test to exercise a rejection.
  const toolFitChecker: ToolFitChecker = { fits: vi.fn().mockResolvedValue(true) };
  const bestEffortResponder: BestEffortResponder = { respond: vi.fn().mockResolvedValue("best-effort answer") };
  // Defaults to "needs capability" so every existing test (which assumes full
  // retrieval runs) is unaffected; override per-test to exercise the
  // capability-need gate itself.
  const capabilityNeedChecker: CapabilityNeedChecker = { needsCapability: vi.fn().mockResolvedValue(true) };

  return {
    identityResolver,
    skillStore,
    skillSelector,
    skillFitChecker,
    vectorStore,
    actionPlanner,
    responseComposer,
    containerToolLauncher,
    jobResultReceiver: callbackReceiver,
    toolFitChecker,
    bestEffortResponder,
    capabilityNeedChecker,
    callbackBaseUrl: "http://orchestrator",
    callbackSecret: "s3cret",
    ...overrides,
  };
}

describe("buildAgentGraph", () => {
  it("runs the full happy path for a tool-calling action: identity -> skill -> tools -> plan -> launch -> result", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.identity).toEqual({ subject: "alice", roles: ["reader"] });
    expect(final.selectedSkill?.id).toBe("recipe-publisher-skill");
    expect(final.selectedTool?.id).toBe("recipe-scraper");
    expect(final.result).toEqual({ title: "Pancakes" });
    expect(deps.containerToolLauncher.launch).toHaveBeenCalledWith(
      scraperTool.jobTemplate,
      expect.objectContaining({ callbackSecret: "s3cret", args: ["https://example.com/recipe"] }),
    );
  });

  it("responds directly with no tool call for an in-chat edit action", async () => {
    const deps = baseDeps({
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "respond",
          response: '{"recipe":{"tags":["vegetarian"]}}',
        } satisfies PlannedAction),
      },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "make it vegetarian, here's the recipe: {...}", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.selectedTool).toBeUndefined();
    expect(final.result).toBe('{"recipe":{"tags":["vegetarian"]}}');
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("supports a respond-only skill (no toolIds, ADR 0011) without hitting the tool store", async () => {
    const respondOnlySkill: SkillDescriptor = { ...skill, id: "faq-skill", toolIds: [] };
    const deps = baseDeps({
      skillStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn().mockResolvedValue([{ skill: respondOnlySkill, score: 0.9 }]),
        getByIds: vi.fn().mockResolvedValue([]),
      },
      skillSelector: { select: vi.fn().mockResolvedValue(respondOnlySkill) },
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({ action: "respond", response: "Here's how it works." } satisfies PlannedAction),
      },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "how does publishing work?", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe("Here's how it works.");
    expect(deps.vectorStore.getByIds).not.toHaveBeenCalled();
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("wraps a string tool result with the skill's composed narration, preserving the output verbatim (ADR 0015)", async () => {
    const deps = baseDeps({
      responseComposer: {
        compose: vi.fn().mockResolvedValue({ prefix: null, suffix: "\n\n---\nConfirm to publish?" }),
      },
      jobResultReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "# Pancakes\n\n## Ingredients\n\n1. 2 eggs",
        } satisfies Event),
        onJobProgress: vi.fn().mockReturnValue(() => {}),
      } as unknown as JobResultReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe("# Pancakes\n\n## Ingredients\n\n1. 2 eggs\n\n---\nConfirm to publish?");
    // The tool output is passed to the composer verbatim, and the composer's
    // narration is only appended around it (never a rewrite of the Markdown).
    expect(deps.responseComposer.compose).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: "recipe-publisher-skill" }),
      scraperTool,
      "# Pancakes\n\n## Ingredients\n\n1. 2 eggs",
    );
  });

  it("leaves a string tool result verbatim when the composer adds no narration", async () => {
    const deps = baseDeps({
      jobResultReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "# Pancakes\n\n## Ingredients\n\n1. 2 eggs",
        } satisfies Event),
        onJobProgress: vi.fn().mockReturnValue(() => {}),
      } as unknown as JobResultReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe("# Pancakes\n\n## Ingredients\n\n1. 2 eggs");
  });

  it("does not invoke the composer for a non-string (structured) tool result", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toEqual({ title: "Pancakes" });
    expect(deps.responseComposer.compose).not.toHaveBeenCalled();
  });

  it("fails closed when identity cannot be resolved, without ever querying the skill store", async () => {
    const deps = baseDeps({ identityResolver: { resolve: vi.fn().mockResolvedValue(undefined) } });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "bad-token" });

    expect(final.error).toMatch(/unauthorized/);
    expect(deps.skillStore.query).not.toHaveBeenCalled();
  });

  it("falls through to a best-effort LLM answer (no error) when no candidate skills are retrieved", async () => {
    const deps = baseDeps({
      skillStore: { upsert: vi.fn(), delete: vi.fn(), query: vi.fn().mockResolvedValue([]), getByIds: vi.fn().mockResolvedValue([]) },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toContain("best-effort answer");
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("falls through to a best-effort LLM answer (no error) when the skill selector picks none of the candidates", async () => {
    const deps = baseDeps({ skillSelector: { select: vi.fn().mockResolvedValue(undefined) } });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toContain("best-effort answer");
  });

  it("stops with an error when the selected skill has no usable tools for this caller", async () => {
    const deps = baseDeps({
      vectorStore: { upsert: vi.fn(), delete: vi.fn(), query: vi.fn(), getByIds: vi.fn().mockResolvedValue([]) },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/no usable tools/);
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("stops with an error when the planner selects a tool outside the skill's scope", async () => {
    const deps = baseDeps({
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "some-other-tool",
          toolArgs: "x",
        } satisfies PlannedAction),
      },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/outside the skill's scope/);
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("surfaces a failed tool-Job result as a graph error", async () => {
    const deps = baseDeps({
      jobResultReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "failed",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          code: "extraction",
          message: "could not extract",
        } satisfies Event),
        onJobProgress: vi.fn().mockReturnValue(() => {}),
      } as unknown as JobResultReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/tool failed \(extraction\)/);
  });

  it("runs a LocalTool via the executor sidecar instead of launching a Job (ADR 0014)", async () => {
    const localTool: ToolDescriptor = {
      id: "http-get-node",
      name: "http-get-node",
      description: "Fetches a URL",
      allowedRoles: ["reader"],
      localExec: { runtime: "node", package: "http-get", version: "1.0.0", network: true },
    };
    const localSkill: SkillDescriptor = { ...skill, id: "fetch-skill", toolIds: ["http-get-node"] };
    const localToolExecutor = {
      run: vi.fn().mockResolvedValue({
        type: "succeeded",
        job_id: "local-1",
        seq: 0,
        ts: new Date().toISOString(),
        result: { status: 200, body: "hi" },
      } satisfies Event),
    };
    const deps = baseDeps({
      skillStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn().mockResolvedValue([{ skill: localSkill, score: 0.9 }]),
        getByIds: vi.fn().mockResolvedValue([localSkill]),
      },
      skillSelector: { select: vi.fn().mockResolvedValue(localSkill) },
      vectorStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn(),
        getByIds: vi.fn().mockResolvedValue([{ tool: localTool, score: 1 }]),
      },
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "http-get-node",
          toolArgs: "https://example.com",
        } satisfies PlannedAction),
      },
      localToolExecutor: localToolExecutor as unknown as AgentGraphDeps["localToolExecutor"],
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "fetch https://example.com", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toEqual({ status: 200, body: "hi" });
    expect(localToolExecutor.run).toHaveBeenCalledWith(localTool, "https://example.com");
    // A LocalTool must never take the Job path.
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });

  it("fails gracefully when a LocalTool is selected but no executor is configured", async () => {
    const localTool: ToolDescriptor = {
      id: "http-get-node",
      name: "http-get-node",
      description: "Fetches a URL",
      allowedRoles: ["reader"],
      localExec: { runtime: "node", package: "http-get", version: "1.0.0", network: true },
    };
    const localSkill: SkillDescriptor = { ...skill, id: "fetch-skill", toolIds: ["http-get-node"] };
    const deps = baseDeps({
      skillStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn().mockResolvedValue([{ skill: localSkill, score: 0.9 }]),
        getByIds: vi.fn().mockResolvedValue([localSkill]),
      },
      skillSelector: { select: vi.fn().mockResolvedValue(localSkill) },
      vectorStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn(),
        getByIds: vi.fn().mockResolvedValue([{ tool: localTool, score: 1 }]),
      },
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "http-get-node",
          toolArgs: "https://example.com",
        } satisfies PlannedAction),
      },
      localToolExecutor: undefined,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "fetch https://example.com", authToken: "tok" });

    expect(final.error).toMatch(/local execution is not configured/);
    expect(deps.containerToolLauncher.launch).not.toHaveBeenCalled();
  });
});

describe("buildAgentGraph session-scoped active skill (ADR 0012)", () => {
  it("keeps the active skill and skips retrieval + selection when the fit-check passes", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "yes, publish it",
      authToken: "tok",
      activeSkillId: skill.id,
      sessionSubject: "alice",
    });

    expect(final.error).toBeUndefined();
    expect(final.selectedSkill?.id).toBe(skill.id);
    expect(deps.skillStore.getByIds).toHaveBeenCalledWith([skill.id], { callerRoles: ["reader"] });
    expect(deps.skillFitChecker.fits).toHaveBeenCalledWith("yes, publish it", skill);
    // The whole point: no RAG retrieval, no selection LLM call.
    expect(deps.skillStore.query).not.toHaveBeenCalled();
    expect(deps.skillSelector.select).not.toHaveBeenCalled();
  });

  it("falls back to full retrieval + selection when the fit-check rejects the turn", async () => {
    const deps = baseDeps({ skillFitChecker: { fits: vi.fn().mockResolvedValue(false) } });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "help me with something unrelated",
      authToken: "tok",
      activeSkillId: skill.id,
      sessionSubject: "alice",
    });

    expect(final.error).toBeUndefined();
    expect(deps.skillStore.query).toHaveBeenCalled();
    expect(deps.skillSelector.select).toHaveBeenCalled();
    expect(final.selectedSkill?.id).toBe(skill.id);
  });

  it("ignores the session when its subject doesn't match the resolved identity", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "yes, publish it",
      authToken: "tok",
      activeSkillId: skill.id,
      sessionSubject: "someone-else",
    });

    expect(final.error).toBeUndefined();
    // Never even fetched or fit-checked -- treated as no session at all.
    expect(deps.skillStore.getByIds).not.toHaveBeenCalled();
    expect(deps.skillFitChecker.fits).not.toHaveBeenCalled();
    expect(deps.skillStore.query).toHaveBeenCalled();
  });

  it("falls back to full retrieval when the active skill no longer resolves under the caller's roles", async () => {
    const deps = baseDeps({
      skillStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn().mockResolvedValue([{ skill, score: 0.9 }]),
        getByIds: vi.fn().mockResolvedValue([]),
      },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "yes, publish it",
      authToken: "tok",
      activeSkillId: skill.id,
      sessionSubject: "alice",
    });

    expect(final.error).toBeUndefined();
    expect(deps.skillFitChecker.fits).not.toHaveBeenCalled();
    expect(deps.skillStore.query).toHaveBeenCalled();
  });

  it("behaves exactly as before when no active skill is supplied", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.skillStore.getByIds).not.toHaveBeenCalled();
    expect(deps.skillFitChecker.fits).not.toHaveBeenCalled();
    expect(deps.skillStore.query).toHaveBeenCalled();
  });
});

describe("buildAgentGraph tool continuation tokens (ADR 0017)", () => {
  it("strips a leading continuation marker from a string tool result and stashes the token for the server to persist", async () => {
    const deps = baseDeps({
      jobResultReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "<!-- continuation: abc-123 -->\n\n# Pancakes",
        } satisfies Event),
        onJobProgress: vi.fn().mockReturnValue(() => {}),
      } as unknown as JobResultReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    // Never reaches composeResponse/the caller with the marker attached.
    expect(final.result).toBe("# Pancakes");
    expect(final.extractedContinuation).toEqual({ toolId: "recipe-scraper", token: "abc-123" });
  });

  it("records an empty token (clearing any stored continuation) when a string result carries no marker", async () => {
    const deps = baseDeps({
      jobResultReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "# Pancakes",
        } satisfies Event),
        onJobProgress: vi.fn().mockReturnValue(() => {}),
      } as unknown as JobResultReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe("# Pancakes");
    expect(final.extractedContinuation).toEqual({ toolId: "recipe-scraper", token: "" });
  });

  it("does not attempt continuation extraction on a non-string (structured) tool result", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.extractedContinuation).toBeUndefined();
  });

  it("prepends a saved continuation token onto tool_args on a repeat call for the same tool", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    await graph.invoke({
      request: "extract the recipe at https://example.com/recipe",
      authToken: "tok",
      toolContinuations: { "recipe-scraper": "abc-123" },
    });

    expect(deps.containerToolLauncher.launch).toHaveBeenCalledWith(
      scraperTool.jobTemplate,
      expect.objectContaining({ args: ["<!-- continuation: abc-123 -->\n\nhttps://example.com/recipe"] }),
    );
  });

  it("does not prefix tool_args when no continuation token is saved for this tool", async () => {
    const deps = baseDeps();
    const graph = buildAgentGraph(deps);

    await graph.invoke({
      request: "extract the recipe at https://example.com/recipe",
      authToken: "tok",
      toolContinuations: { "some-other-tool": "xyz" },
    });

    expect(deps.containerToolLauncher.launch).toHaveBeenCalledWith(
      scraperTool.jobTemplate,
      expect.objectContaining({ args: ["https://example.com/recipe"] }),
    );
  });

  it("scopes the stored continuation to the planner's toolInstanceKey, so distinct instances of a multi-instance tool never share state", async () => {
    const deps = baseDeps({
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "recipe-publisher",
          toolArgs: "# Tacos\n\n## Ingredients\n\n1. tortillas",
          toolInstanceKey: "https://example.com/tacos",
        } satisfies PlannedAction),
      },
      vectorStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn(),
        getByIds: vi.fn().mockResolvedValue([{ tool: publisherTool, score: 1 }]),
      },
    });
    const graph = buildAgentGraph(deps);

    // A prior recipe's slug is stored under a DIFFERENT instance key (a
    // different source URL) -- it must never be prepended onto this call.
    await graph.invoke({
      request: "publish it",
      authToken: "tok",
      toolContinuations: { "recipe-publisher::https://example.com/pancakes": "pancakes-slug" },
    });

    expect(deps.containerToolLauncher.launch).toHaveBeenCalledWith(
      publisherTool.jobTemplate,
      expect.objectContaining({ args: ["# Tacos\n\n## Ingredients\n\n1. tortillas"] }),
    );
  });

  it("prepends the saved continuation for a matching toolInstanceKey", async () => {
    const deps = baseDeps({
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "recipe-publisher",
          toolArgs: "# Tacos\n\n## Ingredients\n\n1. tortillas",
          toolInstanceKey: "https://example.com/tacos",
        } satisfies PlannedAction),
      },
      vectorStore: {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn(),
        getByIds: vi.fn().mockResolvedValue([{ tool: publisherTool, score: 1 }]),
      },
    });
    const graph = buildAgentGraph(deps);

    await graph.invoke({
      request: "make it spicier",
      authToken: "tok",
      toolContinuations: { "recipe-publisher::https://example.com/tacos": "tacos-slug" },
    });

    expect(deps.containerToolLauncher.launch).toHaveBeenCalledWith(
      publisherTool.jobTemplate,
      expect.objectContaining({
        args: ["<!-- continuation: tacos-slug -->\n\n# Tacos\n\n## Ingredients\n\n1. tortillas"],
      }),
    );
  });
});

describe("buildAgentGraph agent delegation continuation tokens (ADR 0017)", () => {
  const codingAgent: AgentDescriptor = {
    id: "opencode-swe",
    name: "opencode-swe",
    description: "Does software engineering tasks",
    allowedRoles: ["reader"],
    agentRunTemplate: { namespace: "default", agentRef: "opencode-swe" },
  };

  function agentDelegationDeps(overrides: Partial<AgentGraphDeps> = {}, reply: Partial<AgentTurnResult> = {}) {
    const agentStore: AgentStore = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue([{ agent: codingAgent, score: 0.9 }]),
      getByIds: vi.fn().mockResolvedValue([codingAgent]),
    };
    const delegateSelector: DelegateSelector = {
      select: vi.fn().mockResolvedValue({ type: "agent", agent: codingAgent }),
    };
    const agentChannel: AgentOrchestratorChannel = {
      awaitReply: vi.fn().mockResolvedValue({
        message: "Opened a pull request",
        final: true,
        narration: [],
        ...reply,
      } satisfies AgentTurnResult),
      sendPrompt: vi.fn(),
      close: vi.fn(),
    };
    const agentRunLauncher: AgentRunLauncherPort = {
      launch: vi.fn().mockResolvedValue({ name: "run-1", namespace: "default" }),
    };
    return baseDeps({
      agentStore,
      delegateSelector,
      agentChannel,
      agentRunLauncher,
      callbackBaseUrl: "http://orchestrator",
      callbackSecretRef: { name: "secret", key: "token" },
      ...overrides,
    });
  }

  it("prepends a saved agent continuation token onto the new episode's goal", async () => {
    const deps = agentDelegationDeps();
    const graph = buildAgentGraph(deps);

    await graph.invoke({
      request: "keep working on the same PR",
      authToken: "tok",
      agentContinuations: { "opencode-swe": "repo=owner/repo branch=feature session=abc" },
    });

    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      codingAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({
        goal: "<!-- continuation: repo=owner/repo branch=feature session=abc -->\n\nkeep working on the same PR",
      }),
    );
  });

  it("does not prefix the goal when no continuation token is saved for this agent", async () => {
    const deps = agentDelegationDeps();
    const graph = buildAgentGraph(deps);

    await graph.invoke({ request: "build me a hello world server", authToken: "tok" });

    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      codingAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ goal: "build me a hello world server" }),
    );
  });

  it("stashes the agent's structured reply.result as the continuation token for the NEXT episode, on a final reply", async () => {
    const deps = agentDelegationDeps({}, { final: true, result: "repo=owner/repo branch=feature session=abc" });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "build me a hello world server", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.extractedAgentContinuation).toEqual({
      agentId: "opencode-swe",
      token: "repo=owner/repo branch=feature session=abc",
    });
  });

  it("does not stash a continuation token on a non-final reply (mid-episode HITL question)", async () => {
    const deps = agentDelegationDeps({}, { final: false, result: "repo=owner/repo branch=feature session=abc" });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "build me a hello world server", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.agentAwaitingReply).toBe(true);
    expect(final.extractedAgentContinuation).toBeUndefined();
  });
});

describe("buildAgentGraph agent-backed Tool (runTool via AgentRun)", () => {
  const agentBackedTool: ToolDescriptor = {
    id: "opencode-swe-agent-tool",
    name: "opencode-swe-agent-tool",
    description: "Delegates to the opencode SWE agent",
    allowedRoles: ["reader"],
    agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
  };

  const agentToolSkill: SkillDescriptor = {
    id: "self-improvement-skill",
    name: "Self Improvement",
    description: "Drafts and PRs a new skill",
    markdown: "# instructions",
    toolIds: ["opencode-swe-agent-tool"],
    agentIds: [],
  };

  function agentBackedToolDeps(overrides: Partial<AgentGraphDeps> = {}, reply: Partial<AgentTurnResult> = {}) {
    const skillStore: SkillStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([{ skill: agentToolSkill, score: 0.9 }]),
      getByIds: vi.fn().mockResolvedValue([agentToolSkill]),
    };
    const vectorStore: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([{ tool: agentBackedTool, score: 1 }]),
    };
    const actionPlanner: ActionPlanner = {
      plan: vi.fn().mockResolvedValue({
        action: "call_tool",
        toolId: "opencode-swe-agent-tool",
        toolArgs: "open a PR adding this skill",
      } satisfies PlannedAction),
    };
    const agentChannel: AgentOrchestratorChannel = {
      awaitReply: vi.fn().mockResolvedValue({
        message: "Opened https://github.com/imaustink/agent-controller/pull/42",
        final: true,
        narration: [],
        ...reply,
      } satisfies AgentTurnResult),
      sendPrompt: vi.fn(),
      close: vi.fn(),
    };
    const agentRunLauncher: AgentRunLauncherPort = {
      launch: vi.fn().mockResolvedValue({ name: "run-1", namespace: "default" }),
    };
    return baseDeps({
      skillStore,
      vectorStore,
      actionPlanner,
      agentChannel,
      agentRunLauncher,
      callbackBaseUrl: "http://orchestrator",
      callbackSecretRef: { name: "secret", key: "token" },
      ...overrides,
    });
  }

  it("dispatches an agent-backed tool as an AgentRun and surfaces the final reply as the tool result", async () => {
    const deps = agentBackedToolDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.selectedTool?.id).toBe("opencode-swe-agent-tool");
    expect(final.result).toBe("Opened https://github.com/imaustink/agent-controller/pull/42");
    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      agentBackedTool.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ goal: "open a PR adding this skill" }),
    );
  });

  it("errors when the agent-backed tool's reply is non-final (v1 scope cut: single-turn only)", async () => {
    const deps = agentBackedToolDeps({}, { final: false });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toMatch(/single-turn/);
    expect(final.result).toBeUndefined();
  });

  it("errors when agent delegation is not configured for an agent-backed tool", async () => {
    const deps = agentBackedToolDeps({ agentRunLauncher: undefined, agentChannel: undefined, callbackSecretRef: undefined });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toMatch(/agent delegation is not configured/);
  });

  describe("identity-gated agent-backed tool (ADR 0022)", () => {
    const identityGatedTool: ToolDescriptor = { ...agentBackedTool, identityProviders: ["github"] };

    function identityGatedDeps(overrides: Partial<AgentGraphDeps> = {}) {
      const vectorStore: VectorStore = {
        upsert: vi.fn(),
        delete: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
        getByIds: vi.fn().mockResolvedValue([{ tool: identityGatedTool, score: 1 }]),
      };
      const identityLinkGateway: IdentityLinkPort = {
        start: vi.fn(),
        poll: vi.fn(),
        getToken: vi.fn().mockResolvedValue(undefined),
      };
      return agentBackedToolDeps({ vectorStore, identityLinkGateway, ...overrides });
    }

    it("injects the caller's already-linked token as secretEnv instead of erroring", async () => {
      const identityLinkGateway: IdentityLinkPort = {
        start: vi.fn(),
        poll: vi.fn(),
        getToken: vi.fn().mockResolvedValue({ token: "gho_alice-token" }),
      };
      const deps = identityGatedDeps({ identityLinkGateway });
      const graph = buildAgentGraph(deps);

      const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

      expect(final.error).toBeUndefined();
      expect(identityLinkGateway.getToken).toHaveBeenCalledWith("github", "alice");
      expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
        identityGatedTool.agentRunTemplate,
        expect.any(String),
        expect.objectContaining({ secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_alice-token" }] }),
      );
    });

    it("errors (without launching) instead of silently running credential-less when the caller has no linked token", async () => {
      const deps = identityGatedDeps();
      const graph = buildAgentGraph(deps);

      const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

      expect(final.error).toMatch(/requires linking your github account/);
      expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    });

    it("errors when identity providers are declared but no identity-link gateway is configured", async () => {
      const deps = identityGatedDeps({ identityLinkGateway: undefined });
      const graph = buildAgentGraph(deps);

      const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

      expect(final.error).toMatch(/no identity-link gateway is configured/);
      expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    });
  });
});

describe("buildAgentGraph Skill.agentRefs (ADR 0021, no Tool wrapper)", () => {
  const opencodeAgent: AgentDescriptor = {
    id: "opencode-swe-agent",
    name: "opencode-swe-agent",
    description: "General-purpose coding agent",
    allowedRoles: ["reader"],
    agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
  };

  const selfImprovementSkill: SkillDescriptor = {
    id: "self-improvement-skill",
    name: "Self Improvement",
    description: "Drafts and PRs a new skill",
    markdown: "# instructions",
    toolIds: [],
    agentIds: ["opencode-swe-agent"],
  };

  function agentRefsDeps(overrides: Partial<AgentGraphDeps> = {}, reply: Partial<AgentTurnResult> = {}) {
    const skillStore: SkillStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([{ skill: selfImprovementSkill, score: 0.9 }]),
      getByIds: vi.fn().mockResolvedValue([selfImprovementSkill]),
    };
    const skillSelector: SkillSelector = { select: vi.fn().mockResolvedValue(selfImprovementSkill) };
    const agentStore: AgentStore = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([{ agent: opencodeAgent, score: 1 }]),
    };
    const actionPlanner: ActionPlanner = {
      plan: vi.fn().mockResolvedValue({
        action: "call_tool",
        toolId: "opencode-swe-agent",
        toolArgs: "open a PR adding this skill",
      } satisfies PlannedAction),
    };
    const agentChannel: AgentOrchestratorChannel = {
      awaitReply: vi.fn().mockResolvedValue({
        message: "Opened https://github.com/imaustink/agent-controller/pull/42",
        final: true,
        narration: [],
        ...reply,
      } satisfies AgentTurnResult),
      sendPrompt: vi.fn(),
      close: vi.fn(),
    };
    const agentRunLauncher: AgentRunLauncherPort = {
      launch: vi.fn().mockResolvedValue({ name: "run-1", namespace: "default" }),
    };
    return baseDeps({
      skillStore,
      skillSelector,
      agentStore,
      actionPlanner,
      agentChannel,
      agentRunLauncher,
      callbackBaseUrl: "http://orchestrator",
      callbackSecretRef: { name: "secret", key: "token" },
      ...overrides,
    });
  }

  it("resolves a skill's agentRefs via agentStore and dispatches straight to an AgentRun, no Tool CR involved", async () => {
    const deps = agentRefsDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.selectedTool?.id).toBe("opencode-swe-agent");
    expect(final.selectedTool?.agentRunTemplate).toEqual(opencodeAgent.agentRunTemplate);
    expect(final.result).toBe("Opened https://github.com/imaustink/agent-controller/pull/42");
    expect(deps.agentStore!.getByIds).toHaveBeenCalledWith(["opencode-swe-agent"], { callerRoles: ["reader"] });
    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      opencodeAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ goal: "open a PR adding this skill" }),
    );
  });

  it("errors when a skill declares agentRefs but agent delegation (agentStore) is not configured", async () => {
    const deps = agentRefsDeps({ agentStore: undefined });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toMatch(/agent delegation is not configured/);
  });

  it("carries an agentRefs-resolved Agent's identityProviders through to the ToolDescriptor and gates the launch on it (regression: this used to launch with no credentials at all)", async () => {
    const identityGatedAgent: AgentDescriptor = { ...opencodeAgent, identityProviders: ["github"] };
    const agentStore: AgentStore = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([{ agent: identityGatedAgent, score: 1 }]),
    };
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn(),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    const deps = agentRefsDeps({ agentStore, identityLinkGateway });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "add a permanent skill for this", authToken: "tok" });

    expect(final.error).toMatch(/requires linking your github account/);
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
  });
});

describe("buildAgentGraph best-effort LLM answer on no match (no hardcoded fallback agent)", () => {
  const realAgent: AgentDescriptor = {
    id: "opencode-swe-agent",
    name: "opencode-swe-agent",
    description: "General-purpose coding agent",
    allowedRoles: ["reader"],
    agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
  };

  function noMatchDeps(overrides: Partial<AgentGraphDeps> = {}) {
    const skillStore: SkillStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn(),
    };
    const agentStore: AgentStore = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn(),
    };
    const delegateSelector: DelegateSelector = { select: vi.fn().mockResolvedValue(null) };
    const agentRunLauncher: AgentRunLauncherPort = { launch: vi.fn() };
    return baseDeps({
      skillStore,
      agentStore,
      delegateSelector,
      agentRunLauncher,
      callbackBaseUrl: "http://orchestrator",
      callbackSecretRef: { name: "secret", key: "token" },
      ...overrides,
    });
  }

  it("gives a bare best-effort LLM answer, never launching an agent, when no skill/agent candidates exist at all", async () => {
    const deps = noMatchDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do something niche", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(deps.bestEffortResponder.respond).toHaveBeenCalledWith("do something niche");
    expect(final.result).toContain("best-effort answer");
    expect(final.result).toContain("self-improvement");
  });

  it("gives a bare best-effort LLM answer when the delegate selector picks no candidate", async () => {
    const deps = noMatchDeps();
    (deps.skillStore.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { skill: { id: "unrelated", name: "unrelated", description: "x", markdown: "x", toolIds: [], agentIds: [] }, score: 0.1 },
    ]);
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do something niche", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.result).toContain("self-improvement");
  });

  it("does not append the self-improvement suggestion for an ordinary (non-fallback) agent delegation", async () => {
    const deps = noMatchDeps({
      agentChannel: {
        awaitReply: vi.fn().mockResolvedValue({ message: "Opened a pull request", final: true, narration: [] } satisfies AgentTurnResult),
        sendPrompt: vi.fn(),
        close: vi.fn(),
      },
      agentRunLauncher: { launch: vi.fn().mockResolvedValue({ name: "run-1", namespace: "default" }) },
    });
    (deps.skillStore.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (deps.agentStore!.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ agent: realAgent, score: 0.9 }]);
    (deps.delegateSelector!.select as ReturnType<typeof vi.fn>).mockResolvedValue({ type: "agent", agent: realAgent });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do something niche", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).not.toContain("self-improvement");
  });
});

describe("buildAgentGraph fallback tool-fit (tried before the best-effort LLM answer)", () => {
  function noMatchWithToolDeps(overrides: Partial<AgentGraphDeps> = {}) {
    const skillStore: SkillStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn(),
    };
    const vectorStore: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn().mockResolvedValue([{ tool: scraperTool, score: 0.8 }]),
      getByIds: vi.fn(),
    };
    return baseDeps({ skillStore, vectorStore, ...overrides });
  }

  it("calls a directly-fitting tool from the full catalog when no skill/agent matched, without touching the fallback agent", async () => {
    const actionPlanner: ActionPlanner = {
      plan: vi.fn().mockResolvedValue({
        action: "call_tool",
        toolId: "recipe-scraper",
        toolArgs: "https://example.com/recipe",
      } satisfies PlannedAction),
    };
    const agentRunLauncher: AgentRunLauncherPort = { launch: vi.fn() };
    const deps = noMatchWithToolDeps({ actionPlanner, agentRunLauncher });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "scrape https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.selectedSkill).toBeUndefined();
    expect(final.selectedTool?.id).toBe("recipe-scraper");
    expect(deps.containerToolLauncher.launch).toHaveBeenCalled();
    expect(agentRunLauncher.launch).not.toHaveBeenCalled();
    // baseDeps' default tool result is structured (non-string) -- no
    // self-improvement suggestion is appended to it (same "only string
    // results" rule as composeResponse); see the string-result test below
    // for the suggestion-append path.
    expect(final.result).toEqual({ title: "Pancakes" });
  });

  it("appends the self-improvement suggestion to a string result from a fallback-selected tool", async () => {
    const actionPlanner: ActionPlanner = {
      plan: vi.fn().mockResolvedValue({
        action: "call_tool",
        toolId: "recipe-scraper",
        toolArgs: "https://example.com/recipe",
      } satisfies PlannedAction),
    };
    const jobResultReceiver = {
      awaitJob: vi.fn().mockResolvedValue({
        type: "succeeded",
        job_id: "job-1",
        seq: 1,
        ts: new Date(0).toISOString(),
        result: "# Pancakes",
      } satisfies Event),
      onJobProgress: vi.fn(),
    } as unknown as JobResultReceiver;
    const deps = noMatchWithToolDeps({ actionPlanner, jobResultReceiver });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "scrape https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toContain("# Pancakes");
    expect(final.result).toContain("self-improvement");
  });

  it("falls through to a bare best-effort LLM answer when the fallback tool planner declines (no clear fit)", async () => {
    const actionPlanner: ActionPlanner = {
      plan: vi.fn().mockResolvedValue({ action: "respond", response: "not a clear fit" } satisfies PlannedAction),
    };
    const agentRunLauncher: AgentRunLauncherPort = { launch: vi.fn() };
    const deps = noMatchWithToolDeps({ actionPlanner, agentRunLauncher });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do something niche", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.selectedTool).toBeUndefined();
    expect(agentRunLauncher.launch).not.toHaveBeenCalled();
    expect(deps.bestEffortResponder.respond).toHaveBeenCalledWith("do something niche");
    expect(final.result).toContain("self-improvement");
  });

  it("rejects a tool that only surfaces via loose embedding overlap (toolFitChecker), falling through to a best-effort answer", async () => {
    // Mirrors the real incident this cascade was built to prevent: a request
    // to "create a recipe" surfacing an unrelated "create a repository" tool
    // by embedding similarity alone. toolFitChecker is the second, narrower
    // check that must reject it before the action planner ever sees it.
    const toolFitChecker: ToolFitChecker = { fits: vi.fn().mockResolvedValue(false) };
    const actionPlanner: ActionPlanner = { plan: vi.fn() };
    const agentRunLauncher: AgentRunLauncherPort = { launch: vi.fn() };
    const deps = noMatchWithToolDeps({ toolFitChecker, actionPlanner, agentRunLauncher });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "help me create a recipe from scratch", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.toolFitChecker.fits).toHaveBeenCalledWith("help me create a recipe from scratch", scraperTool);
    // The rejected candidate never reaches the action planner at all.
    expect(actionPlanner.plan).not.toHaveBeenCalled();
    expect(agentRunLauncher.launch).not.toHaveBeenCalled();
    expect(final.result).toContain("best-effort answer");
  });

  it("does not attempt a fallback tool call when the caller has no resolved identity", async () => {
    const identityResolver: IdentityResolver = { resolve: vi.fn().mockResolvedValue(undefined) };
    const deps = noMatchWithToolDeps({ identityResolver });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "scrape https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBe("unauthorized: could not resolve caller identity");
  });
});

describe("buildAgentGraph capability-need gate (no search for conversational requests, ADR 0019)", () => {
  it("skips catalog retrieval and the self-improvement suggestion when no capability is needed", async () => {
    const capabilityNeedChecker: CapabilityNeedChecker = { needsCapability: vi.fn().mockResolvedValue(false) };
    const deps = baseDeps({ capabilityNeedChecker });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "what's a good substitute for buttermilk?", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.capabilityNeedChecker.needsCapability).toHaveBeenCalledWith("what's a good substitute for buttermilk?");
    expect(deps.skillStore.query).not.toHaveBeenCalled();
    expect(deps.vectorStore.query).not.toHaveBeenCalled();
    expect(deps.bestEffortResponder.respond).toHaveBeenCalledWith("what's a good substitute for buttermilk?");
    expect(final.result).toBe("best-effort answer");
    expect(final.result).not.toContain("self-improvement");
    expect(final.wasFallback).toBe(false);
  });

  it("streams the answer via the progress listener and leaves result empty, still with no self-improvement suggestion", async () => {
    const capabilityNeedChecker: CapabilityNeedChecker = { needsCapability: vi.fn().mockResolvedValue(false) };
    const bestEffortResponder: BestEffortResponder = {
      respond: vi.fn().mockImplementation(async (_request: string, onToken?: (delta: string) => void) => {
        onToken?.("streamed answer");
        return "streamed answer";
      }),
    };
    const deps = baseDeps({ capabilityNeedChecker, bestEffortResponder });
    const graph = buildAgentGraph(deps);
    const progressListener = vi.fn();

    const final = await graph.invoke({ request: "tell me a joke", authToken: "tok", progressListener });

    expect(final.error).toBeUndefined();
    expect(progressListener).toHaveBeenCalledWith("agent-text", "streamed answer");
    expect(final.result).toBe("");
    expect(deps.skillStore.query).not.toHaveBeenCalled();
  });

  it("proceeds with the normal retrieval flow unchanged when a capability is judged needed", async () => {
    const capabilityNeedChecker: CapabilityNeedChecker = { needsCapability: vi.fn().mockResolvedValue(true) };
    const deps = baseDeps({ capabilityNeedChecker });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "scrape and publish this recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(deps.capabilityNeedChecker.needsCapability).toHaveBeenCalledWith("scrape and publish this recipe");
    expect(deps.skillStore.query).toHaveBeenCalled();
  });
});

describe("buildAgentGraph per-caller identity linking (GitHub OAuth Device Flow)", () => {
  const githubAgent: AgentDescriptor = {
    id: "opencode-swe",
    name: "opencode-swe",
    description: "Does software engineering tasks",
    allowedRoles: ["reader"],
    identityProviders: ["github"],
    agentRunTemplate: { namespace: "default", agentRef: "opencode-swe" },
  };

  function identityLinkDeps(overrides: Partial<AgentGraphDeps> = {}, reply: Partial<AgentTurnResult> = {}) {
    const agentStore: AgentStore = {
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue([{ agent: githubAgent, score: 0.9 }]),
      getByIds: vi.fn().mockResolvedValue([githubAgent]),
    };
    const delegateSelector: DelegateSelector = {
      select: vi.fn().mockResolvedValue({ type: "agent", agent: githubAgent }),
    };
    const agentChannel: AgentOrchestratorChannel = {
      awaitReply: vi.fn().mockResolvedValue({
        message: "Opened a pull request",
        final: true,
        narration: [],
        ...reply,
      } satisfies AgentTurnResult),
      sendPrompt: vi.fn(),
      close: vi.fn(),
    };
    const agentRunLauncher: AgentRunLauncherPort = {
      launch: vi.fn().mockResolvedValue({ name: "run-1", namespace: "default" }),
    };
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn().mockResolvedValue({
        flow: "device" as const,
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        deviceCode: "raw-device-code",
        expiresInSeconds: 900,
        pollIntervalSeconds: 5,
      }),
      poll: vi.fn().mockResolvedValue("complete"),
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    return baseDeps({
      agentStore,
      delegateSelector,
      agentChannel,
      agentRunLauncher,
      identityLinkGateway,
      callbackBaseUrl: "http://orchestrator",
      callbackSecretRef: { name: "secret", key: "token" },
      ...overrides,
    });
  }

  it("starts a device-flow link (identityLinkFlow: \"device\" explicitly set) and does NOT launch the agent when the caller has no linked token yet", async () => {
    const deps = identityLinkDeps();
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "open a PR that fixes the bug",
      authToken: "tok",
      identityLinkFlow: "device",
    });

    expect(final.error).toBeUndefined();
    expect(deps.identityLinkGateway!.getToken).toHaveBeenCalledWith("github", "alice");
    expect(deps.identityLinkGateway!.start).toHaveBeenCalledWith("github", "alice", "device");
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.identityLinkPending).toBe(true);
    expect(final.pendingIdentityLink).toEqual({
      agentId: "opencode-swe",
      provider: "github",
      flow: "device",
      deviceCode: "raw-device-code",
      expiresAt: expect.any(Number),
    });
    expect(final.result).toMatch(/github\.com\/login\/device/);
    expect(final.result).toMatch(/ABCD-1234/);
  });

  it("starts an authcode-flow link by default (no identityLinkFlow set) and does NOT launch the agent when the caller has no linked token yet", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn().mockResolvedValue({
        flow: "authcode" as const,
        authorizeUrl: "https://github.com/login/oauth/authorize?state=xyz",
        expiresInSeconds: 600,
      }),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "open a PR that fixes the bug", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(identityLinkGateway.getToken).toHaveBeenCalledWith("github", "alice");
    expect(identityLinkGateway.start).toHaveBeenCalledWith("github", "alice", "authcode");
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.identityLinkPending).toBe(true);
    expect(final.pendingIdentityLink).toEqual({
      agentId: "opencode-swe",
      provider: "github",
      flow: "authcode",
      expiresAt: expect.any(Number),
    });
    expect(final.pendingIdentityLink?.deviceCode).toBeUndefined();
    expect(final.result).toMatch(/github\.com\/login\/oauth\/authorize/);
  });

  it("holds the turn open via waitForCompletion on a streaming call and launches without ending the turn once linked", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn().mockResolvedValue({
        flow: "authcode" as const,
        authorizeUrl: "https://github.com/login/oauth/authorize?state=xyz",
        expiresInSeconds: 600,
      }),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: vi.fn().mockResolvedValue({ token: "gho_resolved-token", githubLogin: "alice-gh" }),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);
    const progressListener = vi.fn();

    const final = await graph.invoke({ request: "open a PR that fixes the bug", authToken: "tok", progressListener });

    expect(progressListener).toHaveBeenCalledWith("identity-link", expect.stringContaining("github.com/login/oauth/authorize"));
    expect(identityLinkGateway.waitForCompletion).toHaveBeenCalledWith("github", "alice", 600_000);
    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      githubAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_resolved-token" }] }),
    );
    expect(final.identityLinkPending).toBeFalsy();
    expect(final.pendingIdentityLink).toBeUndefined();
    expect(final.agentRunId).toBeDefined();
  });

  it("falls back to the pending-link message when waitForCompletion times out on a streaming call", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn().mockResolvedValue({
        flow: "authcode" as const,
        authorizeUrl: "https://github.com/login/oauth/authorize?state=xyz",
        expiresInSeconds: 600,
      }),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);
    const progressListener = vi.fn();

    const final = await graph.invoke({ request: "open a PR that fixes the bug", authToken: "tok", progressListener });

    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.identityLinkPending).toBe(true);
    expect(final.pendingIdentityLink).toEqual({
      agentId: "opencode-swe",
      provider: "github",
      flow: "authcode",
      expiresAt: expect.any(Number),
    });
    expect(final.result).toMatch(/send any message once you're done/);
  });

  it("resumes delegation and launches with secretEnv once a pending link's poll reports complete", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn(),
      poll: vi.fn().mockResolvedValue("complete"),
      getToken: vi.fn().mockResolvedValue({ token: "gho_resolved-token", githubLogin: "alice-gh" }),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "continue please",
      authToken: "tok",
      sessionSubject: "alice",
      pendingIdentityLink: {
        agentId: "opencode-swe",
        provider: "github",
        flow: "device",
        deviceCode: "raw-device-code",
        expiresAt: Date.now() + 900_000,
      },
    });

    expect(final.error).toBeUndefined();
    expect(identityLinkGateway.poll).toHaveBeenCalledWith("github", "alice", "raw-device-code");
    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      githubAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_resolved-token" }] }),
    );
    expect(final.pendingIdentityLink).toBeUndefined();
    expect(final.agentRunId).toBeDefined();
  });

  it("ends the turn with identityLinkPending true and the pending link preserved when poll reports still-pending before expiry", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn(),
      poll: vi.fn().mockResolvedValue("pending"),
      getToken: vi.fn(),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);
    const pending = {
      agentId: "opencode-swe",
      provider: "github",
      flow: "device" as const,
      deviceCode: "raw-device-code",
      expiresAt: Date.now() + 900_000,
    };

    const final = await graph.invoke({
      request: "still working on it",
      authToken: "tok",
      sessionSubject: "alice",
      pendingIdentityLink: pending,
    });

    expect(final.error).toBeUndefined();
    expect(final.identityLinkPending).toBe(true);
    expect(final.pendingIdentityLink).toEqual(pending);
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.result).toMatch(/still waiting/i);
  });

  it("clears the pending link and falls through to normal selection when poll reports expired", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn().mockResolvedValue({
        flow: "device" as const,
        verificationUri: "https://github.com/login/device",
        userCode: "NEW-CODE",
        deviceCode: "new-device-code",
        expiresInSeconds: 900,
        pollIntervalSeconds: 5,
      }),
      poll: vi.fn().mockResolvedValue("expired"),
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "let's try again",
      authToken: "tok",
      sessionSubject: "alice",
      // Same caller forces device flow again on the fresh attempt below.
      identityLinkFlow: "device",
      pendingIdentityLink: {
        agentId: "opencode-swe",
        provider: "github",
        flow: "device",
        deviceCode: "raw-device-code",
        expiresAt: Date.now() - 1_000, // already expired
      },
    });

    expect(final.error).toBeUndefined();
    // Falls through to fresh retrieval/selection, which re-detects the
    // missing link and starts a BRAND NEW device-flow attempt.
    expect(deps.identityLinkGateway!.start).toHaveBeenCalledWith("github", "alice", "device");
    expect(final.pendingIdentityLink).toEqual({
      agentId: "opencode-swe",
      provider: "github",
      flow: "device",
      deviceCode: "new-device-code",
      expiresAt: expect.any(Number),
    });
  });

  it("resumes delegation via authcode's getToken check (not poll) when a pending authcode link's token has landed", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn(),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue({ token: "gho_resolved-token", githubLogin: "alice-gh" }),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({
      request: "continue please",
      authToken: "tok",
      sessionSubject: "alice",
      pendingIdentityLink: {
        agentId: "opencode-swe",
        provider: "github",
        flow: "authcode",
        expiresAt: Date.now() + 900_000,
      },
    });

    expect(final.error).toBeUndefined();
    expect(identityLinkGateway.poll).not.toHaveBeenCalled();
    expect(identityLinkGateway.getToken).toHaveBeenCalledWith("github", "alice");
    expect(deps.agentRunLauncher!.launch).toHaveBeenCalledWith(
      githubAgent.agentRunTemplate,
      expect.any(String),
      expect.objectContaining({ secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_resolved-token" }] }),
    );
    expect(final.pendingIdentityLink).toBeUndefined();
    expect(final.agentRunId).toBeDefined();
  });

  it("ends the turn with identityLinkPending true when a pending authcode link's token has not landed yet and it hasn't expired (poll not called)", async () => {
    const identityLinkGateway: IdentityLinkPort = {
      start: vi.fn(),
      poll: vi.fn(),
      getToken: vi.fn().mockResolvedValue(undefined),
    };
    const deps = identityLinkDeps({ identityLinkGateway });
    const graph = buildAgentGraph(deps);
    const pending = {
      agentId: "opencode-swe",
      provider: "github",
      flow: "authcode" as const,
      expiresAt: Date.now() + 900_000,
    };

    const final = await graph.invoke({
      request: "still working on it",
      authToken: "tok",
      sessionSubject: "alice",
      pendingIdentityLink: pending,
    });

    expect(final.error).toBeUndefined();
    expect(identityLinkGateway.poll).not.toHaveBeenCalled();
    expect(identityLinkGateway.getToken).toHaveBeenCalledWith("github", "alice");
    expect(final.identityLinkPending).toBe(true);
    expect(final.pendingIdentityLink).toEqual(pending);
    expect(deps.agentRunLauncher!.launch).not.toHaveBeenCalled();
    expect(final.result).toMatch(/still waiting/i);
  });
});

