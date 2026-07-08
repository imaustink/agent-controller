import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManifestToolRegistry } from "./manifest-tool-registry.js";

const validManifest = {
  id: "recipe-scraper",
  name: "recipe-scraper",
  description: "Scrapes a recipe from a URL.",
  input: "A recipe URL string.",
  output: "A recipe envelope JSON.",
  allowedRoles: ["reader"],
  tier: "standard",
  image: "recipe-scraper:latest",
  serviceAccountName: "recipe-scraper",
};

describe("ManifestToolRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "manifests-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty catalog when the manifests directory doesn't exist", async () => {
    const registry = new ManifestToolRegistry(path.join(dir, "does-not-exist"), "recipe-agent");
    expect(await registry.listAll()).toEqual([]);
  });

  it("loads a valid manifest into a ToolDescriptor with input/output folded into the embedded description", async () => {
    await mkdir(path.join(dir, "recipe-scraper"));
    await writeFile(path.join(dir, "recipe-scraper", "manifest.json"), JSON.stringify(validManifest));

    const registry = new ManifestToolRegistry(dir, "recipe-agent");
    const tools = await registry.listAll();

    expect(tools).toEqual([
      {
        id: "recipe-scraper",
        name: "recipe-scraper",
        description: "Scrapes a recipe from a URL.\n\nInput: A recipe URL string.\nOutput: A recipe envelope JSON.",
        allowedRoles: ["reader"],
        tier: "standard",
        jobTemplate: {
          image: "recipe-scraper:latest",
          // namespace comes from the registry's own config, never the manifest.
          namespace: "recipe-agent",
          serviceAccountName: "recipe-scraper",
          args: undefined,
          env: undefined,
          resources: undefined,
        },
      },
    ]);
  });

  it("skips a tool folder with no manifest.json", async () => {
    await mkdir(path.join(dir, "empty-folder"));

    const registry = new ManifestToolRegistry(dir, "recipe-agent");
    expect(await registry.listAll()).toEqual([]);
  });

  it("skips (and logs) malformed JSON without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mkdir(path.join(dir, "broken"));
    await writeFile(path.join(dir, "broken", "manifest.json"), "{ not valid json");

    const registry = new ManifestToolRegistry(dir, "recipe-agent");
    expect(await registry.listAll()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
    errorSpy.mockRestore();
  });

  it("skips (and logs) a manifest that fails schema validation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mkdir(path.join(dir, "invalid"));
    await writeFile(path.join(dir, "invalid", "manifest.json"), JSON.stringify({ id: "missing-fields" }));

    const registry = new ManifestToolRegistry(dir, "recipe-agent");
    expect(await registry.listAll()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("loads valid manifests alongside skipped invalid ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mkdir(path.join(dir, "recipe-scraper"));
    await writeFile(path.join(dir, "recipe-scraper", "manifest.json"), JSON.stringify(validManifest));
    await mkdir(path.join(dir, "broken"));
    await writeFile(path.join(dir, "broken", "manifest.json"), "not json");

    const registry = new ManifestToolRegistry(dir, "recipe-agent");
    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBe("recipe-scraper");
    vi.restoreAllMocks();
  });
});
