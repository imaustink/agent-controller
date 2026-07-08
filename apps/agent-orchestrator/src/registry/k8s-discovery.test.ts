import { describe, expect, it, vi } from "vitest";
import type { V1DeploymentList } from "@kubernetes/client-node";
import { ANNOTATIONS, K8sAnnotationToolRegistry, type AppsV1ApiLike } from "./k8s-discovery.js";

function deployment(name: string, annotations: Record<string, string>, opts: { image?: string; sa?: string } = {}) {
  return {
    metadata: { name, annotations },
    spec: {
      template: {
        spec: {
          containers: [{ image: opts.image ?? "example.com/tool:latest" }],
          serviceAccountName: opts.sa ?? "tool-sa",
        },
      },
    },
  };
}

describe("K8sAnnotationToolRegistry", () => {
  it("returns only deployments annotated as tools", async () => {
    const list: V1DeploymentList = {
      items: [
        deployment("recipe-scraper", {
          [ANNOTATIONS.tool]: "true",
          [ANNOTATIONS.description]: "Scrapes a recipe from a URL",
          [ANNOTATIONS.allowedRoles]: "reader, writer",
        }) as never,
        deployment("unrelated-service", {}) as never,
      ],
    } as V1DeploymentList;

    const appsApi: AppsV1ApiLike = { listNamespacedDeployment: vi.fn().mockResolvedValue(list) };
    const registry = new K8sAnnotationToolRegistry("default", appsApi);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "recipe-scraper",
      name: "recipe-scraper",
      description: "Scrapes a recipe from a URL",
      allowedRoles: ["reader", "writer"],
      jobTemplate: { image: "example.com/tool:latest", namespace: "default", serviceAccountName: "tool-sa" },
    });
    expect(appsApi.listNamespacedDeployment).toHaveBeenCalledWith({ namespace: "default" });
  });

  it("skips malformed tool-annotated deployments (missing image/service account)", async () => {
    const list: V1DeploymentList = {
      items: [
        {
          metadata: { name: "broken", annotations: { [ANNOTATIONS.tool]: "true" } },
          spec: { template: { spec: { containers: [], serviceAccountName: undefined } } },
        } as never,
      ],
    } as V1DeploymentList;

    const appsApi: AppsV1ApiLike = { listNamespacedDeployment: vi.fn().mockResolvedValue(list) };
    const registry = new K8sAnnotationToolRegistry("default", appsApi);

    await expect(registry.listAll()).resolves.toEqual([]);
  });
});
