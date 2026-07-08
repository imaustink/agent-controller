import { describe, expect, it, vi } from "vitest";
import type { Event } from "@recipe-agent/messaging";
import { buildAgentGraph, type AgentGraphDeps } from "./graph.js";
import type { IdentityResolver } from "../rbac/types.js";
import type { SkillStore } from "../skills/types.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { SkillSelector } from "./skill-selector.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner, PlannedAction } from "./action-planner.js";
import type { JobLauncher } from "../k8s/job-launcher.js";
import type { CallbackReceiver } from "../callback/receiver.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { SkillFitChecker } from "./skill-fit-checker.js";

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
    query: vi.fn(),
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
  const jobLauncher = { launch: vi.fn().mockResolvedValue({ name: "tool-1", namespace: "default" }) } as unknown as JobLauncher;
  const callbackReceiver = {
    awaitJob: vi.fn().mockResolvedValue({
      type: "succeeded",
      job_id: "job-1",
      seq: 1,
      ts: new Date().toISOString(),
      result: { title: "Pancakes" },
    } satisfies Event),
  } as unknown as CallbackReceiver;

  return {
    identityResolver,
    skillStore,
    skillSelector,
    skillFitChecker,
    vectorStore,
    actionPlanner,
    jobLauncher,
    callbackReceiver,
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
    expect(deps.jobLauncher.launch).toHaveBeenCalledWith(
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
    expect(deps.jobLauncher.launch).not.toHaveBeenCalled();
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
    expect(deps.jobLauncher.launch).not.toHaveBeenCalled();
  });

  it("appends a publish-confirmation prompt to a successful recipe-scraper string result", async () => {
    const deps = baseDeps({
      callbackReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "# Pancakes\n\n## Ingredients\n\n1. 2 eggs",
        } satisfies Event),
      } as unknown as CallbackReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "extract the recipe at https://example.com/recipe", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe(
      "# Pancakes\n\n## Ingredients\n\n1. 2 eggs\n\n---\nReply to confirm publishing this to Mealie, or tell me what you'd like to change first.",
    );
  });

  it("does NOT append the publish-confirmation prompt to a successful recipe-publisher result", async () => {
    const deps = baseDeps({
      actionPlanner: {
        plan: vi.fn().mockResolvedValue({
          action: "call_tool",
          toolId: "recipe-publisher",
          toolArgs: "# Pancakes\n\n## Ingredients\n\n1. 2 eggs",
        } satisfies PlannedAction),
      },
      callbackReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "succeeded",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          result: "# Pancakes\n\n## Ingredients\n\n1. 2 eggs\n\n---\n✅ Published on Mealie: [Pancakes](https://recipes.example.com/g/home/r/pancakes)",
        } satisfies Event),
      } as unknown as CallbackReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "publish it", authToken: "tok" });

    expect(final.error).toBeUndefined();
    expect(final.result).toBe(
      "# Pancakes\n\n## Ingredients\n\n1. 2 eggs\n\n---\n✅ Published on Mealie: [Pancakes](https://recipes.example.com/g/home/r/pancakes)",
    );
  });

  it("fails closed when identity cannot be resolved, without ever querying the skill store", async () => {
    const deps = baseDeps({ identityResolver: { resolve: vi.fn().mockResolvedValue(undefined) } });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "bad-token" });

    expect(final.error).toMatch(/unauthorized/);
    expect(deps.skillStore.query).not.toHaveBeenCalled();
  });

  it("stops with an error when no candidate skills are retrieved", async () => {
    const deps = baseDeps({
      skillStore: { upsert: vi.fn(), delete: vi.fn(), query: vi.fn().mockResolvedValue([]), getByIds: vi.fn().mockResolvedValue([]) },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/no matching skill/);
    expect(deps.jobLauncher.launch).not.toHaveBeenCalled();
  });

  it("stops with an error when the skill selector picks none of the candidates", async () => {
    const deps = baseDeps({ skillSelector: { select: vi.fn().mockResolvedValue(undefined) } });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/no matching skill/);
  });

  it("stops with an error when the selected skill has no usable tools for this caller", async () => {
    const deps = baseDeps({
      vectorStore: { upsert: vi.fn(), delete: vi.fn(), query: vi.fn(), getByIds: vi.fn().mockResolvedValue([]) },
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/no usable tools/);
    expect(deps.jobLauncher.launch).not.toHaveBeenCalled();
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
    expect(deps.jobLauncher.launch).not.toHaveBeenCalled();
  });

  it("surfaces a failed tool-Job result as a graph error", async () => {
    const deps = baseDeps({
      callbackReceiver: {
        awaitJob: vi.fn().mockResolvedValue({
          type: "failed",
          job_id: "job-1",
          seq: 1,
          ts: new Date().toISOString(),
          code: "extraction",
          message: "could not extract",
        } satisfies Event),
      } as unknown as CallbackReceiver,
    });
    const graph = buildAgentGraph(deps);

    const final = await graph.invoke({ request: "do a thing", authToken: "tok" });

    expect(final.error).toMatch(/tool failed \(extraction\)/);
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

