import { describe, expect, it, vi } from "vitest";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import {
  CrdIntegrationRouteRegistry,
  renderPromptTemplate,
  type IntegrationRouteCustomResource,
} from "./crd-integration-route-registry.js";

const labeledRoute: IntegrationRouteCustomResource = {
  metadata: { name: "github-issue-labeled-triage" },
  spec: {
    match: { source: "github", event: "issues", action: "labeled" },
    agentRef: "opencode-swe-agent",
    promptTemplate: "Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}",
  },
};

describe("CrdIntegrationRouteRegistry", () => {
  it("maps IntegrationRoute custom resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [labeledRoute] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const routes = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "integrationroutes",
    });
    expect(routes).toEqual([
      {
        id: "github-issue-labeled-triage",
        source: "github",
        event: "issues",
        action: "labeled",
        skillRef: undefined,
        agentRef: "opencode-swe-agent",
        toolRef: undefined,
        promptTemplate: "Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}",
      },
    ]);
  });

  it("skips a malformed route (missing promptTemplate) rather than failing the whole table", async () => {
    const malformed = {
      metadata: { name: "broken-route" },
      spec: { match: { source: "github", event: "issues" } },
    } as IntegrationRouteCustomResource;
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [malformed, labeledRoute] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const routes = await registry.listAll();

    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("github-issue-labeled-triage");
  });

  describe("match", () => {
    it("returns the route whose action matches exactly", async () => {
      const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [labeledRoute] });
      const api: CustomObjectsApiLike = { listNamespacedCustomObject };
      const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      await registry.listAll();

      expect(registry.match("github", "issues", "labeled")?.id).toBe("github-issue-labeled-triage");
    });

    it("returns undefined when no route matches source/event/action", async () => {
      const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [labeledRoute] });
      const api: CustomObjectsApiLike = { listNamespacedCustomObject };
      const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      await registry.listAll();

      expect(registry.match("github", "issues", "opened")).toBeUndefined();
      expect(registry.match("github", "issue_comment", "created")).toBeUndefined();
    });

    it("prefers an exact action match over a wildcard (action-less) route", async () => {
      const wildcard: IntegrationRouteCustomResource = {
        metadata: { name: "github-issues-catchall" },
        spec: {
          match: { source: "github", event: "issues" },
          agentRef: "some-other-agent",
          promptTemplate: "catchall",
        },
      };
      const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [wildcard, labeledRoute] });
      const api: CustomObjectsApiLike = { listNamespacedCustomObject };
      const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      await registry.listAll();

      expect(registry.match("github", "issues", "labeled")?.id).toBe("github-issue-labeled-triage");
      expect(registry.match("github", "issues", "closed")?.id).toBe("github-issues-catchall");
    });
  });

  describe("watch", () => {
    it("upserts on ADDED/MODIFIED and removes on DELETED", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts.plural).toBe("integrationroutes");
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdIntegrationRouteRegistry(
        "default",
        "core.controller-agent.dev",
        "v1alpha1",
        api,
        watchFn,
      );
      registry.watch(() => {});

      onEvent("ADDED", labeledRoute);
      expect(registry.match("github", "issues", "labeled")?.id).toBe("github-issue-labeled-triage");

      onEvent("DELETED", labeledRoute);
      expect(registry.match("github", "issues", "labeled")).toBeUndefined();
    });

    it("throws when constructed without a watchFn", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      const registry = new CrdIntegrationRouteRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      expect(() => registry.watch(() => {})).toThrow();
    });
  });
});

describe("renderPromptTemplate", () => {
  it("substitutes known fields", () => {
    const result = renderPromptTemplate("Issue {{owner}}/{{repo}}#{{issueNumber}}: {{title}}", {
      owner: "imaustink",
      repo: "recipe-agent",
      issueNumber: 42,
      title: "Bug in the parser",
    });
    expect(result).toBe("Issue imaustink/recipe-agent#42: Bug in the parser");
  });

  it("leaves unmatched placeholders verbatim", () => {
    const result = renderPromptTemplate("Hello {{unknownField}}", { owner: "imaustink" });
    expect(result).toBe("Hello {{unknownField}}");
  });
});
