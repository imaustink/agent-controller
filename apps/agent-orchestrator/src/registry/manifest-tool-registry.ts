import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { ToolRegistry } from "./types.js";

/** Filename expected inside each tool's manifest directory. */
export const MANIFEST_FILENAME = "manifest.json";

const ResourcesSchema = z
  .object({
    requests: z.object({ cpu: z.string().optional(), memory: z.string().optional() }).optional(),
    limits: z.object({ cpu: z.string().optional(), memory: z.string().optional() }).optional(),
  })
  .optional();

/**
 * A tool's static, build-time manifest (ADR 0009): describes what the tool
 * does (including its input/output shape, for RAG matching quality -- not
 * just a one-line description) and the Job template needed to launch it.
 * `namespace` is deliberately NOT part of this schema -- it's assigned by
 * `ManifestToolRegistry` from the orchestrator's own runtime config, since
 * the same manifest may be baked into images deployed to different
 * namespaces/environments.
 */
export const ToolManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** What the tool does, in a sentence or two. */
  description: z.string().min(1),
  /** What a caller must provide (shape/format), in plain language. */
  input: z.string().min(1),
  /** What the tool produces (shape/format), in plain language. */
  output: z.string().min(1),
  allowedRoles: z.array(z.string()).default([]),
  tier: z.string().optional(),
  image: z.string().min(1),
  serviceAccountName: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  resources: ResourcesSchema,
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/**
 * Static, build-time tool catalog (ADR 0009 -- supersedes the annotated-
 * Deployment discovery in ../registry/k8s-discovery.ts, ADR 0004). Reads one
 * `<manifestsDir>/<tool>/manifest.json` per tool, all baked into this image
 * at build time (see the Dockerfile's per-tool `COPY .../manifest.json`
 * lines). No live cluster lookup is needed: tools are only ever launched
 * on-demand as Jobs (ADR 0005), so there's no always-running Deployment to
 * discover in the first place -- the manifest is the source of truth.
 */
export class ManifestToolRegistry implements ToolRegistry {
  constructor(
    private readonly manifestsDir: string,
    private readonly namespace: string,
  ) {}

  async listAll(): Promise<ToolDescriptor[]> {
    let entries;
    try {
      entries = await readdir(this.manifestsDir, { withFileTypes: true });
    } catch (err) {
      // No manifests directory baked in (e.g. local dev, or zero tools yet)
      // -- an empty catalog, not a startup failure.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const tools: ToolDescriptor[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(this.manifestsDir, entry.name, MANIFEST_FILENAME);
      const manifest = await this.loadManifest(manifestPath);
      if (!manifest) continue;
      tools.push({
        id: manifest.id,
        name: manifest.name,
        description: `${manifest.description}\n\nInput: ${manifest.input}\nOutput: ${manifest.output}`,
        allowedRoles: manifest.allowedRoles,
        tier: manifest.tier,
        jobTemplate: {
          image: manifest.image,
          namespace: this.namespace,
          serviceAccountName: manifest.serviceAccountName,
          args: manifest.args,
          env: manifest.env,
          resources: manifest.resources,
        },
      });
    }
    return tools;
  }

  /** Returns `undefined` (logging why) for a missing/malformed manifest rather than failing the whole catalog load. */
  private async loadManifest(manifestPath: string): Promise<ToolManifest | undefined> {
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // not every folder need have one
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.error(`skipping invalid tool manifest at ${manifestPath}: not valid JSON (${(err as Error).message})`);
      return undefined;
    }

    const parsed = ToolManifestSchema.safeParse(json);
    if (!parsed.success) {
      console.error(`skipping invalid tool manifest at ${manifestPath}: ${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  }
}
